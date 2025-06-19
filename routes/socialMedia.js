const express = require('express');
const Joi = require('joi');
const { supabase } = require('../config/supabase');
const { requirePermission } = require('../middleware/auth');
const { catchAsync, APIError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const socialMediaService = require('../services/socialMedia');

const router = express.Router();

// Validation schemas
const fetchReportsSchema = Joi.object({
  disaster_id: Joi.string().uuid().required(),
  provider: Joi.string().valid('twitter', 'bluesky', 'mock').optional(),
  max_results: Joi.number().integer().min(1).max(100).default(50),
  time_window: Joi.number().integer().min(1).max(168).default(24), // 1 hour to 1 week
  save_to_db: Joi.boolean().default(true),
  filter_urgent: Joi.boolean().default(false)
});

const analyzePostSchema = Joi.object({
  content: Joi.string().min(1).max(2000).required(),
  disaster_context: Joi.object({
    location_name: Joi.string().optional(),
    tags: Joi.array().items(Joi.string()).optional(),
    description: Joi.string().optional()
  }).optional()
});

/**
 * GET /social-media/disasters/:id/reports - Fetch social media reports for a disaster
 */
router.get('/disasters/:id/reports', requirePermission('read'), catchAsync(async (req, res) => {
  const { id: disasterId } = req.params;
  const {
    provider,
    max_results = 50,
    time_window = 24,
    save_to_db = true,
    filter_urgent = false,
    refresh = false
  } = req.query;

  logger.info('Fetching social media reports', {
    disasterId,
    provider,
    maxResults: max_results,
    timeWindow: time_window,
    userId: req.user.id
  });

  try {
    // First, get disaster details
    const { data: disaster, error: disasterError } = await supabase
      .from('disasters')
      .select('*')
      .eq('id', disasterId)
      .single();

    if (disasterError) {
      if (disasterError.code === 'PGRST116') {
        throw new APIError('Disaster not found', 404);
      }
      throw new APIError('Failed to fetch disaster details', 500);
    }

    // Check if we should fetch fresh data or use cached/stored data
    let posts = [];
    let fromCache = false;

    if (!refresh) {
      // Try to get recent posts from database first
      const { data: storedPosts, error: storageError } = await supabase
        .from('social_media_posts')
        .select('*')
        .eq('disaster_id', disasterId)
        .gte('processed_at', new Date(Date.now() - time_window * 60 * 60 * 1000).toISOString())
        .order('processed_at', { ascending: false })
        .limit(max_results);

      if (!storageError && storedPosts.length > 0) {
        posts = storedPosts;
        fromCache = true;
        logger.info('Using stored social media posts', {
          disasterId,
          postCount: posts.length,
          userId: req.user.id
        });
      }
    }

    // If no cached data or refresh requested, fetch fresh data
    if (posts.length === 0 || refresh) {
      posts = await socialMediaService.fetchReports(disasterId, disaster, {
        provider,
        maxResults: parseInt(max_results),
        timeWindow: parseInt(time_window)
      });

      // Save posts to database if requested
      if (save_to_db === 'true' && posts.length > 0) {
        const postsToSave = posts.map(post => ({
          disaster_id: disasterId,
          platform: post.platform,
          post_id: post.id,
          content: post.content,
          author: post.author,
          posted_at: post.createdAt,
          sentiment: post.classification,
          keywords: post.keywords || [],
          engagement_metrics: post.metrics || {},
          is_verified: post.verified || false
        }));

        try {
          const { error: saveError } = await supabase
            .from('social_media_posts')
            .upsert(postsToSave, {
              onConflict: 'post_id',
              ignoreDuplicates: true
            });

          if (saveError) {
            logger.warn('Failed to save social media posts', {
              disasterId,
              error: saveError.message
            });
          } else {
            logger.info('Saved social media posts to database', {
              disasterId,
              savedCount: postsToSave.length
            });
          }
        } catch (saveErr) {
          logger.warn('Error saving social media posts', {
            disasterId,
            error: saveErr.message
          });
        }
      }
    }

    // Filter for urgent posts if requested
    if (filter_urgent === 'true') {
      posts = posts.filter(post => post.isUrgent);
    }

    // Emit real-time update for new posts
    if (!fromCache && posts.length > 0) {
      req.io.to(`disaster_${disasterId}`).emit('social_media_updated', {
        disasterId,
        newPosts: posts.length,
        urgentPosts: posts.filter(p => p.isUrgent).length,
        provider: provider || socialMediaService.getServiceInfo().primaryProvider
      });
    }

    res.json({
      success: true,
      data: {
        disaster: {
          id: disaster.id,
          title: disaster.title,
          location_name: disaster.location_name
        },
        posts,
        metadata: {
          total_posts: posts.length,
          urgent_posts: posts.filter(p => p.isUrgent).length,
          platforms: [...new Set(posts.map(p => p.platform))],
          time_range: {
            from: new Date(Date.now() - time_window * 60 * 60 * 1000).toISOString(),
            to: new Date().toISOString()
          },
          from_cache: fromCache,
          provider: provider || socialMediaService.getServiceInfo().primaryProvider,
          fetched_at: new Date().toISOString()
        }
      }
    });

  } catch (error) {
    logger.error('Social media fetch failed', {
      disasterId,
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to fetch social media reports', 500);
  }
}));

/**
 * POST /social-media/analyze-post - Analyze a social media post for disaster relevance
 */
router.post('/analyze-post', requirePermission('read'), catchAsync(async (req, res) => {
  const { error, value } = analyzePostSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  const { content, disaster_context } = value;

  logger.info('Analyzing social media post', {
    contentLength: content.length,
    hasContext: !!disaster_context,
    userId: req.user.id
  });

  try {
    // Create mock disaster object for analysis
    const mockDisaster = {
      location_name: disaster_context?.location_name || 'Unknown',
      tags: disaster_context?.tags || [],
      description: disaster_context?.description || ''
    };

    // Create mock post object
    const mockPost = {
      id: 'analysis_' + Date.now(),
      content,
      author: 'unknown',
      createdAt: new Date().toISOString(),
      platform: 'analysis',
      metrics: { likes: 0, retweets: 0, replies: 0 }
    };

    // Process the post using social media service
    const processedPost = socialMediaService.processPost(mockPost, mockDisaster);

    const analysis = {
      relevance: {
        score: processedPost.relevanceScore,
        keywords_found: processedPost.keywords,
        classification: processedPost.classification,
        is_urgent: processedPost.isUrgent
      },
      sentiment: {
        type: processedPost.classification,
        confidence: processedPost.relevanceScore
      },
      disaster_indicators: {
        contains_help_request: /help|assistance|need|trapped|stranded/gi.test(content),
        contains_location_ref: disaster_context?.location_name ? 
          content.toLowerCase().includes(disaster_context.location_name.toLowerCase()) : false,
        contains_disaster_keywords: processedPost.keywords.length > 0,
        urgency_indicators: processedPost.isUrgent
      },
      recommendations: []
    };

    // Generate recommendations based on analysis
    if (analysis.relevance.is_urgent) {
      analysis.recommendations.push('HIGH PRIORITY: Contains urgent keywords - immediate attention recommended');
    }
    
    if (analysis.relevance.score > 0.7) {
      analysis.recommendations.push('High relevance to disaster - consider for official response');
    } else if (analysis.relevance.score > 0.4) {
      analysis.recommendations.push('Moderate relevance - monitor for updates');
    } else {
      analysis.recommendations.push('Low relevance - likely not disaster-related');
    }

    if (analysis.disaster_indicators.contains_help_request) {
      analysis.recommendations.push('Contains help request - verify and coordinate response if authentic');
    }

    res.json({
      success: true,
      data: {
        input: {
          content: content.substring(0, 100) + (content.length > 100 ? '...' : ''),
          content_length: content.length,
          disaster_context
        },
        analysis,
        processed_post: {
          keywords: processedPost.keywords,
          classification: processedPost.classification,
          relevance_score: processedPost.relevanceScore,
          is_urgent: processedPost.isUrgent
        },
        metadata: {
          analyzed_at: new Date().toISOString(),
          analyzer_version: '1.0'
        }
      }
    });

  } catch (error) {
    logger.error('Social media post analysis failed', {
      error: error.message,
      contentLength: content.length,
      userId: req.user.id
    });
    
    throw new APIError('Failed to analyze social media post', 500);
  }
}));

/**
 * GET /social-media/trending - Get trending disaster-related keywords and hashtags
 */
router.get('/trending', requirePermission('read'), catchAsync(async (req, res) => {
  const {
    time_window = 24,
    min_mentions = 3,
    location_filter
  } = req.query;

  logger.info('Fetching trending disaster keywords', {
    timeWindow: time_window,
    minMentions: min_mentions,
    locationFilter: location_filter,
    userId: req.user.id
  });

  try {
    const cutoffTime = new Date(Date.now() - time_window * 60 * 60 * 1000).toISOString();

    // Get recent social media posts
    let query = supabase
      .from('social_media_posts')
      .select('keywords, content, location_name, posted_at')
      .gte('posted_at', cutoffTime);

    if (location_filter) {
      query = query.ilike('location_name', `%${location_filter}%`);
    }

    const { data: posts, error } = await query.limit(1000);

    if (error) {
      throw new APIError('Failed to fetch social media data', 500);
    }

    // Analyze trending keywords
    const keywordCounts = {};
    const locationCounts = {};
    const hashtagPattern = /#\w+/g;

    posts.forEach(post => {
      // Count keywords
      if (post.keywords && Array.isArray(post.keywords)) {
        post.keywords.forEach(keyword => {
          keywordCounts[keyword] = (keywordCounts[keyword] || 0) + 1;
        });
      }

      // Extract and count hashtags
      const hashtags = post.content.match(hashtagPattern) || [];
      hashtags.forEach(hashtag => {
        const cleanTag = hashtag.toLowerCase();
        keywordCounts[cleanTag] = (keywordCounts[cleanTag] || 0) + 1;
      });

      // Count locations
      if (post.location_name) {
        locationCounts[post.location_name] = (locationCounts[post.location_name] || 0) + 1;
      }
    });

    // Filter and sort trending keywords
    const trendingKeywords = Object.entries(keywordCounts)
      .filter(([keyword, count]) => count >= parseInt(min_mentions))
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([keyword, count]) => ({
        keyword,
        mentions: count,
        trend_score: count / parseInt(time_window) // mentions per hour
      }));

    // Filter and sort trending locations
    const trendingLocations = Object.entries(locationCounts)
      .filter(([location, count]) => count >= parseInt(min_mentions))
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([location, count]) => ({
        location,
        mentions: count,
        trend_score: count / parseInt(time_window)
      }));

    res.json({
      success: true,
      data: {
        trending_keywords: trendingKeywords,
        trending_locations: trendingLocations,
        analysis_period: {
          hours: parseInt(time_window),
          from: cutoffTime,
          to: new Date().toISOString()
        },
        statistics: {
          total_posts_analyzed: posts.length,
          unique_keywords: Object.keys(keywordCounts).length,
          unique_locations: Object.keys(locationCounts).length,
          min_mentions_threshold: parseInt(min_mentions)
        },
        metadata: {
          analyzed_at: new Date().toISOString(),
          location_filter: location_filter || null
        }
      }
    });

  } catch (error) {
    logger.error('Trending analysis failed', {
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to analyze trending keywords', 500);
  }
}));

/**
 * POST /social-media/bulk-fetch - Fetch reports for multiple disasters
 */
router.post('/bulk-fetch', requirePermission('read'), catchAsync(async (req, res) => {
  const bulkSchema = Joi.object({
    disaster_ids: Joi.array().items(Joi.string().uuid()).min(1).max(5).required(),
    provider: Joi.string().valid('twitter', 'bluesky', 'mock').optional(),
    max_results_per_disaster: Joi.number().integer().min(1).max(50).default(20),
    time_window: Joi.number().integer().min(1).max(168).default(24)
  });

  const { error, value } = bulkSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  const { disaster_ids, provider, max_results_per_disaster, time_window } = value;

  logger.info('Bulk fetching social media reports', {
    disasterCount: disaster_ids.length,
    provider,
    maxResults: max_results_per_disaster,
    userId: req.user.id
  });

  try {
    // Get all disasters
    const { data: disasters, error: disasterError } = await supabase
      .from('disasters')
      .select('*')
      .in('id', disaster_ids);

    if (disasterError) {
      throw new APIError('Failed to fetch disaster details', 500);
    }

    if (disasters.length !== disaster_ids.length) {
      const foundIds = disasters.map(d => d.id);
      const missingIds = disaster_ids.filter(id => !foundIds.includes(id));
      throw new APIError(`Disasters not found: ${missingIds.join(', ')}`, 404);
    }

    // Fetch reports for each disaster
    const fetchPromises = disasters.map(async (disaster) => {
      try {
        const posts = await socialMediaService.fetchReports(disaster.id, disaster, {
          provider,
          maxResults: max_results_per_disaster,
          timeWindow: time_window
        });

        return {
          disaster_id: disaster.id,
          disaster_title: disaster.title,
          success: true,
          posts,
          post_count: posts.length,
          urgent_posts: posts.filter(p => p.isUrgent).length
        };
      } catch (error) {
        logger.warn('Failed to fetch reports for disaster', {
          disasterId: disaster.id,
          error: error.message
        });

        return {
          disaster_id: disaster.id,
          disaster_title: disaster.title,
          success: false,
          posts: [],
          post_count: 0,
          urgent_posts: 0,
          error: error.message
        };
      }
    });

    const results = await Promise.all(fetchPromises);

    // Calculate overall statistics
    const totalPosts = results.reduce((sum, r) => sum + r.post_count, 0);
    const totalUrgent = results.reduce((sum, r) => sum + r.urgent_posts, 0);
    const successfulFetches = results.filter(r => r.success).length;

    // Emit real-time updates for each disaster
    results.forEach(result => {
      if (result.success && result.post_count > 0) {
        req.io.to(`disaster_${result.disaster_id}`).emit('social_media_updated', {
          disasterId: result.disaster_id,
          newPosts: result.post_count,
          urgentPosts: result.urgent_posts,
          provider: provider || socialMediaService.getServiceInfo().primaryProvider
        });
      }
    });

    res.json({
      success: true,
      data: {
        results,
        summary: {
          disasters_processed: disaster_ids.length,
          successful_fetches: successfulFetches,
          failed_fetches: disaster_ids.length - successfulFetches,
          total_posts_found: totalPosts,
          total_urgent_posts: totalUrgent,
          success_rate: `${(successfulFetches / disaster_ids.length * 100).toFixed(1)}%`
        },
        metadata: {
          provider: provider || socialMediaService.getServiceInfo().primaryProvider,
          time_window_hours: time_window,
          max_results_per_disaster,
          fetched_at: new Date().toISOString()
        }
      }
    });

  } catch (error) {
    logger.error('Bulk social media fetch failed', {
      error: error.message,
      disasterIds: disaster_ids,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Bulk fetch failed', 500);
  }
}));

/**
 * GET /social-media/service-info - Get social media service information
 */
router.get('/service-info', requirePermission('read'), catchAsync(async (req, res) => {
  try {
    const serviceInfo = socialMediaService.getServiceInfo();
    const healthCheck = await socialMediaService.healthCheck();

    res.json({
      success: true,
      data: {
        service_status: {
          healthy: healthCheck,
          primary_provider: serviceInfo.primaryProvider,
          available_providers: serviceInfo.availableProviders
        },
        capabilities: {
          real_time_monitoring: true,
          urgency_detection: true,
          sentiment_analysis: true,
          keyword_extraction: true,
          location_detection: false, // Would need additional geocoding
          bulk_processing: true
        },
        configuration: {
          disaster_keywords: serviceInfo.disasterKeywords,
          urgent_keywords: serviceInfo.urgentKeywords,
          platforms_supported: ['twitter', 'bluesky', 'mock'],
          max_results_per_request: 100,
          cache_duration_minutes: 10
        },
        rate_limits: {
          requests_per_minute: 60,
          bulk_fetch_max_disasters: 5,
          trending_analysis_max_posts: 1000
        }
      }
    });

  } catch (error) {
    logger.error('Service info request failed', {
      error: error.message,
      userId: req.user.id
    });
    
    throw new APIError('Failed to fetch service information', 500);
  }
}));

module.exports = router;