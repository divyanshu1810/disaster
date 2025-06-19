const express = require('express');
const Joi = require('joi');
const { supabase } = require('../config/supabase');
const { requirePermission } = require('../middleware/auth');
const { catchAsync, APIError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const officialUpdatesService = require('../services/officialUpdates');

const router = express.Router();

// Validation schemas
const fetchUpdatesSchema = Joi.object({
  disaster_id: Joi.string().uuid().required(),
  sources: Joi.array().items(
    Joi.string().valid('fema', 'redcross', 'cdc', 'nws')
  ).optional(),
  max_results: Joi.number().integer().min(1).max(50).default(20),
  time_window: Joi.number().integer().min(1).max(168).default(72), // 1 hour to 1 week
  save_to_db: Joi.boolean().default(true),
  refresh: Joi.boolean().default(false)
});

const searchUpdatesSchema = Joi.object({
  keywords: Joi.array().items(Joi.string()).min(1).max(10).required(),
  sources: Joi.array().items(
    Joi.string().valid('fema', 'redcross', 'cdc', 'nws')
  ).optional(),
  max_results: Joi.number().integer().min(1).max(50).default(20),
  time_window: Joi.number().integer().min(1).max(168).default(72)
});

/**
 * GET /official-updates/disasters/:id - Get official updates for a disaster
 */
router.get('/disasters/:id', requirePermission('read'), catchAsync(async (req, res) => {
  const { id: disasterId } = req.params;
  const {
    sources,
    max_results = 20,
    time_window = 72,
    save_to_db = true,
    refresh = false,
    priority_only = false
  } = req.query;

  logger.info('Fetching official updates for disaster', {
    disasterId,
    sources,
    maxResults: max_results,
    timeWindow: time_window,
    refresh,
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
    let updates = [];
    let fromCache = false;

    if (!refresh) {
      // Try to get recent updates from database first
      const cutoffTime = new Date(Date.now() - time_window * 60 * 60 * 1000).toISOString();
      
      let query = supabase
        .from('official_updates')
        .select('*')
        .eq('disaster_id', disasterId)
        .gte('fetched_at', cutoffTime)
        .order('published_at', { ascending: false })
        .limit(parseInt(max_results));

      if (priority_only === 'true') {
        query = query.gte('priority_level', 3);
      }

      const { data: storedUpdates, error: storageError } = await query;

      if (!storageError && storedUpdates.length > 0) {
        updates = storedUpdates;
        fromCache = true;
        logger.info('Using stored official updates', {
          disasterId,
          updateCount: updates.length,
          userId: req.user.id
        });
      }
    }

    // If no cached data or refresh requested, fetch fresh data
    if (updates.length === 0 || refresh) {
      const sourcesArray = sources ? (Array.isArray(sources) ? sources : [sources]) : undefined;
      
      updates = await officialUpdatesService.fetchUpdates(disasterId, disaster, {
        sources: sourcesArray,
        maxResults: parseInt(max_results),
        timeWindow: parseInt(time_window)
      });

      // Save updates to database if requested
      if (save_to_db === 'true' && updates.length > 0) {
        const updatesToSave = updates.map(update => ({
          disaster_id: disasterId,
          source: update.source,
          title: update.title,
          content: update.content,
          url: update.url,
          published_at: update.publishedAt,
          update_type: update.updateType,
          priority_level: update.priorityLevel
        }));

        try {
          const { error: saveError } = await supabase
            .from('official_updates')
            .upsert(updatesToSave, {
              onConflict: 'disaster_id,url',
              ignoreDuplicates: true
            });

          if (saveError) {
            logger.warn('Failed to save official updates', {
              disasterId,
              error: saveError.message
            });
          } else {
            logger.info('Saved official updates to database', {
              disasterId,
              savedCount: updatesToSave.length
            });
          }
        } catch (saveErr) {
          logger.warn('Error saving official updates', {
            disasterId,
            error: saveErr.message
          });
        }
      }
    }

    // Filter for priority updates if requested
    if (priority_only === 'true' && !fromCache) {
      updates = updates.filter(update => (update.priorityLevel || update.priority_level) >= 3);
    }

    // Emit real-time update for new updates
    if (!fromCache && updates.length > 0) {
      req.io.to(`disaster_${disasterId}`).emit('official_updates_received', {
        disasterId,
        newUpdates: updates.length,
        priorityUpdates: updates.filter(u => (u.priorityLevel || u.priority_level) >= 4).length,
        sources: [...new Set(updates.map(u => u.source))]
      });
    }

    // Group updates by source and priority
    const updatesBySource = {};
    const updatesByPriority = {};
    
    updates.forEach(update => {
      const source = update.source;
      const priority = update.priorityLevel || update.priority_level || 1;
      
      if (!updatesBySource[source]) {
        updatesBySource[source] = [];
      }
      updatesBySource[source].push(update);
      
      if (!updatesByPriority[priority]) {
        updatesByPriority[priority] = [];
      }
      updatesByPriority[priority].push(update);
    });

    res.json({
      success: true,
      data: {
        disaster: {
          id: disaster.id,
          title: disaster.title,
          location_name: disaster.location_name
        },
        updates,
        updates_by_source: updatesBySource,
        updates_by_priority: updatesByPriority,
        metadata: {
          total_updates: updates.length,
          priority_updates: updates.filter(u => (u.priorityLevel || u.priority_level) >= 4).length,
          sources_queried: Object.keys(updatesBySource),
          time_range: {
            from: new Date(Date.now() - time_window * 60 * 60 * 1000).toISOString(),
            to: new Date().toISOString()
          },
          from_cache: fromCache,
          fetched_at: new Date().toISOString()
        }
      }
    });

  } catch (error) {
    logger.error('Official updates fetch failed', {
      disasterId,
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to fetch official updates', 500);
  }
}));

/**
 * POST /official-updates/search - Search official updates by keywords
 */
router.post('/search', requirePermission('read'), catchAsync(async (req, res) => {
  const { error, value } = searchUpdatesSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  const { keywords, sources, max_results, time_window } = value;

  logger.info('Searching official updates', {
    keywords,
    sources,
    maxResults: max_results,
    timeWindow: time_window,
    userId: req.user.id
  });

  try {
    const cutoffTime = new Date(Date.now() - time_window * 60 * 60 * 1000).toISOString();
    
    // Search in stored updates first
    let query = supabase
      .from('official_updates')
      .select(`
        *,
        disaster:disasters(id, title, location_name)
      `)
      .gte('published_at', cutoffTime);

    // Apply source filter
    if (sources && sources.length > 0) {
      query = query.in('source', sources);
    }

    const { data: storedUpdates, error: searchError } = await query
      .order('published_at', { ascending: false })
      .limit(1000); // Get more data for better filtering

    if (searchError) {
      throw new APIError('Failed to search stored updates', 500);
    }

    // Filter by keywords (case-insensitive)
    const keywordPattern = new RegExp(keywords.join('|'), 'gi');
    const matchingUpdates = storedUpdates.filter(update => {
      const searchText = `${update.title} ${update.content}`.toLowerCase();
      return keywords.some(keyword => 
        searchText.includes(keyword.toLowerCase())
      ) || keywordPattern.test(update.title + ' ' + update.content);
    });

    // Sort by relevance (number of keyword matches and priority)
    const scoredUpdates = matchingUpdates.map(update => {
      const searchText = `${update.title} ${update.content}`.toLowerCase();
      let score = 0;
      
      keywords.forEach(keyword => {
        const keywordLower = keyword.toLowerCase();
        const titleMatches = (update.title.toLowerCase().match(new RegExp(keywordLower, 'g')) || []).length;
        const contentMatches = (update.content.toLowerCase().match(new RegExp(keywordLower, 'g')) || []).length;
        
        score += titleMatches * 3; // Title matches weighted higher
        score += contentMatches;
      });
      
      // Boost score based on priority level
      score += (update.priority_level || 1) * 2;
      
      // Boost score based on recency
      const ageHours = (Date.now() - new Date(update.published_at).getTime()) / (1000 * 60 * 60);
      if (ageHours < 24) score += 5;
      else if (ageHours < 72) score += 2;
      
      return { ...update, relevance_score: score };
    });

    // Sort by relevance score and limit results
    const sortedUpdates = scoredUpdates
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, max_results);

    // Group results by disaster and source
    const resultsByDisaster = {};
    const resultsBySource = {};
    
    sortedUpdates.forEach(update => {
      // Group by disaster
      if (update.disaster) {
        const disasterId = update.disaster.id;
        if (!resultsByDisaster[disasterId]) {
          resultsByDisaster[disasterId] = {
            disaster: update.disaster,
            updates: []
          };
        }
        resultsByDisaster[disasterId].updates.push(update);
      }
      
      // Group by source
      const source = update.source;
      if (!resultsBySource[source]) {
        resultsBySource[source] = [];
      }
      resultsBySource[source].push(update);
    });

    res.json({
      success: true,
      data: {
        updates: sortedUpdates,
        results_by_disaster: resultsByDisaster,
        results_by_source: resultsBySource,
        search_parameters: {
          keywords,
          sources: sources || 'all',
          max_results,
          time_window_hours: time_window
        },
        metadata: {
          total_found: sortedUpdates.length,
          disasters_affected: Object.keys(resultsByDisaster).length,
          sources_found: Object.keys(resultsBySource),
          search_performed_at: new Date().toISOString(),
          average_relevance_score: sortedUpdates.length > 0 ? 
            (sortedUpdates.reduce((sum, u) => sum + u.relevance_score, 0) / sortedUpdates.length).toFixed(2) : 0
        }
      }
    });

  } catch (error) {
    logger.error('Official updates search failed', {
      keywords,
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to search official updates', 500);
  }
}));

/**
 * GET /official-updates/sources - Get available update sources and their status
 */
router.get('/sources', requirePermission('read'), catchAsync(async (req, res) => {
  try {
    const serviceInfo = officialUpdatesService.getServiceInfo();
    const healthStatus = await officialUpdatesService.healthCheck();

    // Get recent update counts by source
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // Last 24 hours
    
    const { data: recentUpdates, error } = await supabase
      .from('official_updates')
      .select('source')
      .gte('fetched_at', cutoffTime);

    const updateCounts = {};
    if (!error && recentUpdates) {
      recentUpdates.forEach(update => {
        updateCounts[update.source] = (updateCounts[update.source] || 0) + 1;
      });
    }

    // Enhance source details with update counts
    const enhancedSources = serviceInfo.sourceDetails.map(source => ({
      ...source,
      recent_updates_24h: updateCounts[source.key] || 0,
      status: 'active' // In a real system, you might check actual connectivity
    }));

    res.json({
      success: true,
      data: {
        service_status: {
          healthy: healthStatus,
          enabled_sources: serviceInfo.enabledSources.length,
          total_sources: serviceInfo.totalSources
        },
        sources: enhancedSources,
        capabilities: {
          real_time_fetching: true,
          keyword_filtering: true,
          priority_classification: true,
          multiple_sources: true,
          content_caching: true
        },
        configuration: {
          disaster_keywords: serviceInfo.disasterKeywords,
          update_frequency: 'on-demand',
          cache_duration: '30 minutes',
          supported_update_types: ['alert', 'advisory', 'update', 'evacuation', 'relief']
        },
        metadata: {
          service_version: '1.0',
          last_health_check: new Date().toISOString(),
          total_recent_updates: Object.values(updateCounts).reduce((sum, count) => sum + count, 0)
        }
      }
    });

  } catch (error) {
    logger.error('Sources info request failed', {
      error: error.message,
      userId: req.user.id
    });
    
    throw new APIError('Failed to fetch sources information', 500);
  }
}));

/**
 * POST /official-updates/refresh-all - Refresh updates for all active disasters
 */
router.post('/refresh-all', requirePermission('update'), catchAsync(async (req, res) => {
  const {
    max_disasters = 10,
    time_window = 72,
    sources
  } = req.body;

  logger.info('Refreshing updates for all active disasters', {
    maxDisasters: max_disasters,
    timeWindow: time_window,
    sources,
    userId: req.user.id
  });

  try {
    // Get active disasters
    const { data: disasters, error: disasterError } = await supabase
      .from('disasters')
      .select('id, title, location_name, tags, description')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(parseInt(max_disasters));

    if (disasterError) {
      throw new APIError('Failed to fetch active disasters', 500);
    }

    if (disasters.length === 0) {
      return res.json({
        success: true,
        data: {
          message: 'No active disasters found',
          disasters_processed: 0,
          total_updates: 0
        }
      });
    }

    // Fetch updates for each disaster
    const fetchPromises = disasters.map(async (disaster) => {
      try {
        const updates = await officialUpdatesService.fetchUpdates(disaster.id, disaster, {
          sources: sources,
          maxResults: 20,
          timeWindow: parseInt(time_window)
        });

        // Save to database
        if (updates.length > 0) {
          const updatesToSave = updates.map(update => ({
            disaster_id: disaster.id,
            source: update.source,
            title: update.title,
            content: update.content,
            url: update.url,
            published_at: update.publishedAt,
            update_type: update.updateType,
            priority_level: update.priorityLevel
          }));

          const { error: saveError } = await supabase
            .from('official_updates')
            .upsert(updatesToSave, {
              onConflict: 'disaster_id,url',
              ignoreDuplicates: true
            });

          if (saveError) {
            logger.warn('Failed to save updates during refresh', {
              disasterId: disaster.id,
              error: saveError.message
            });
          }
        }

        return {
          disaster_id: disaster.id,
          disaster_title: disaster.title,
          success: true,
          updates_found: updates.length,
          priority_updates: updates.filter(u => u.priorityLevel >= 4).length
        };
      } catch (error) {
        logger.warn('Failed to refresh updates for disaster', {
          disasterId: disaster.id,
          error: error.message
        });

        return {
          disaster_id: disaster.id,
          disaster_title: disaster.title,
          success: false,
          updates_found: 0,
          priority_updates: 0,
          error: error.message
        };
      }
    });

    const results = await Promise.all(fetchPromises);

    // Calculate summary statistics
    const totalUpdates = results.reduce((sum, r) => sum + r.updates_found, 0);
    const totalPriorityUpdates = results.reduce((sum, r) => sum + r.priority_updates, 0);
    const successfulRefreshes = results.filter(r => r.success).length;

    // Emit real-time updates
    req.io.emit('bulk_updates_refreshed', {
      disasters_processed: disasters.length,
      successful_refreshes: successfulRefreshes,
      total_updates: totalUpdates,
      priority_updates: totalPriorityUpdates,
      refreshed_by: req.user.username
    });

    logger.info('Bulk refresh completed', {
      disastersProcessed: disasters.length,
      successfulRefreshes,
      totalUpdates,
      userId: req.user.id
    });

    res.json({
      success: true,
      data: {
        results,
        summary: {
          disasters_processed: disasters.length,
          successful_refreshes: successfulRefreshes,
          failed_refreshes: disasters.length - successfulRefreshes,
          total_updates_found: totalUpdates,
          priority_updates_found: totalPriorityUpdates,
          success_rate: `${(successfulRefreshes / disasters.length * 100).toFixed(1)}%`
        },
        metadata: {
          refreshed_by: req.user.username,
          refreshed_at: new Date().toISOString(),
          time_window_hours: time_window,
          sources_used: sources || 'all'
        }
      }
    });

  } catch (error) {
    logger.error('Bulk refresh failed', {
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to refresh updates', 500);
  }
}));

/**
 * GET /official-updates/trending - Get trending topics from official updates
 */
router.get('/trending', requirePermission('read'), catchAsync(async (req, res) => {
  const {
    time_window = 24,
    min_mentions = 2,
    max_topics = 20
  } = req.query;

  logger.info('Fetching trending topics from official updates', {
    timeWindow: time_window,
    minMentions: min_mentions,
    userId: req.user.id
  });

  try {
    const cutoffTime = new Date(Date.now() - time_window * 60 * 60 * 1000).toISOString();

    // Get recent official updates
    const { data: updates, error } = await supabase
      .from('official_updates')
      .select('title, content, source, update_type, priority_level, published_at')
      .gte('published_at', cutoffTime)
      .limit(500);

    if (error) {
      throw new APIError('Failed to fetch recent updates', 500);
    }

    // Extract and count keywords/topics
    const topicCounts = {};
    const updateTypeCounts = {};
    const sourceCounts = {};

    const commonWords = new Set(['the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'must', 'a', 'an']);

    updates.forEach(update => {
      // Extract topics from title and content
      const text = `${update.title} ${update.content}`.toLowerCase();
      const words = text.match(/\b[a-z]{3,}\b/g) || [];
      
      words.forEach(word => {
        if (!commonWords.has(word) && word.length >= 3) {
          topicCounts[word] = (topicCounts[word] || 0) + 1;
        }
      });

      // Count update types
      if (update.update_type) {
        updateTypeCounts[update.update_type] = (updateTypeCounts[update.update_type] || 0) + 1;
      }

      // Count sources
      sourceCounts[update.source] = (sourceCounts[update.source] || 0) + 1;
    });

    // Filter and sort trending topics
    const trendingTopics = Object.entries(topicCounts)
      .filter(([topic, count]) => count >= parseInt(min_mentions))
      .sort(([, a], [, b]) => b - a)
      .slice(0, parseInt(max_topics))
      .map(([topic, count]) => ({
        topic,
        mentions: count,
        trend_score: count / parseInt(time_window), // mentions per hour
        relevance: count > 5 ? 'high' : count > 2 ? 'medium' : 'low'
      }));

    // Sort update types and sources
    const sortedUpdateTypes = Object.entries(updateTypeCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([type, count]) => ({ type, count }));

    const sortedSources = Object.entries(sourceCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([source, count]) => ({ source, count }));

    res.json({
      success: true,
      data: {
        trending_topics: trendingTopics,
        update_types: sortedUpdateTypes,
        active_sources: sortedSources,
        analysis_period: {
          hours: parseInt(time_window),
          from: cutoffTime,
          to: new Date().toISOString()
        },
        statistics: {
          total_updates_analyzed: updates.length,
          unique_topics: Object.keys(topicCounts).length,
          trending_topics_count: trendingTopics.length,
          min_mentions_threshold: parseInt(min_mentions)
        },
        metadata: {
          analyzed_at: new Date().toISOString(),
          analysis_method: 'keyword_frequency'
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
    throw new APIError('Failed to analyze trending topics', 500);
  }
}));

module.exports = router;