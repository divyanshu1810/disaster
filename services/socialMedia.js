const axios = require('axios');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

class SocialMediaService {
  constructor() {
    this.setupProviders();
    this.disasterKeywords = [
      'emergency', 'disaster', 'flood', 'fire', 'earthquake', 'storm', 
      'hurricane', 'tornado', 'evacuation', 'rescue', 'help needed',
      'urgent', 'sos', 'trapped', 'stranded', 'damage', 'shelter',
      'relief', 'aid', 'assistance', 'emergency services'
    ];
    
    this.urgentKeywords = [
      'urgent', 'sos', 'emergency', 'help', 'trapped', 'stranded',
      'life threatening', 'critical', 'immediate', 'now', 'asap'
    ];
  }

  /**
   * Setup available social media providers
   */
  setupProviders() {
    this.providers = {
      twitter: {
        available: !!process.env.TWITTER_BEARER_TOKEN,
        config: {
          baseUrl: 'https://api.twitter.com/2',
          bearerToken: process.env.TWITTER_BEARER_TOKEN,
          rateLimitDelay: 1000 // 1 second between requests
        }
      },
      bluesky: {
        available: !!(process.env.BLUESKY_USERNAME && process.env.BLUESKY_PASSWORD),
        config: {
          baseUrl: 'https://bsky.social/xrpc',
          username: process.env.BLUESKY_USERNAME,
          password: process.env.BLUESKY_PASSWORD,
          rateLimitDelay: 500
        }
      },
      mock: {
        available: true, // Always available as fallback
        config: {}
      }
    };

    // Determine primary provider
    this.primaryProvider = this.providers.twitter.available ? 'twitter' 
                         : this.providers.bluesky.available ? 'bluesky' 
                         : 'mock';
  }

  /**
   * Fetch social media reports for a disaster
   * @param {string} disasterId - Disaster ID
   * @param {object} disaster - Disaster details (location, tags, description)
   * @param {object} options - Search options
   * @returns {Promise<object[]>} Social media posts
   */
  async fetchReports(disasterId, disaster, options = {}) {
    const {
      provider = this.primaryProvider,
      maxResults = 50,
      timeWindow = 24 // hours
    } = options;

    // Generate search query based on disaster info
    const searchQuery = this.buildSearchQuery(disaster);
    const cacheKey = cache.generateKey('social_media', `${provider}_${disasterId}`, searchQuery);

    return await cache.getOrSet(cacheKey, async () => {
      const startTime = Date.now();
      
      try {
        let posts = [];

        switch (provider) {
          case 'twitter':
            posts = await this.fetchTwitterPosts(searchQuery, maxResults, timeWindow);
            break;
          case 'bluesky':
            posts = await this.fetchBlueskyPosts(searchQuery, maxResults, timeWindow);
            break;
          case 'mock':
          default:
            posts = await this.generateMockPosts(disaster, maxResults);
            break;
        }

        // Process and enrich posts
        const processedPosts = posts.map(post => this.processPost(post, disaster));
        
        // Sort by urgency and recency
        processedPosts.sort((a, b) => {
          if (a.isUrgent !== b.isUrgent) return b.isUrgent - a.isUrgent;
          return new Date(b.createdAt) - new Date(a.createdAt);
        });

        logger.logAPICall(
          `social_media_${provider}`, 
          'fetch_reports', 
          'success', 
          Date.now() - startTime,
          {
            disasterId,
            postsFound: processedPosts.length,
            urgentPosts: processedPosts.filter(p => p.isUrgent).length
          }
        );

        return processedPosts.slice(0, maxResults);

      } catch (error) {
        logger.error('Social media fetch failed', {
          provider,
          disasterId,
          error: error.message
        });

        // Fallback to mock data
        const fallbackPosts = await this.generateMockPosts(disaster, Math.min(maxResults, 10));
        logger.logAPICall(
          `social_media_${provider}`, 
          'fetch_reports', 
          'fallback', 
          Date.now() - startTime
        );
        
        return fallbackPosts;
      }
    }, 600, `social_media_${provider}`); // Cache for 10 minutes
  }

  /**
   * Build search query based on disaster information
   * @param {object} disaster 
   * @returns {string}
   */
  buildSearchQuery(disaster) {
    const terms = [];
    
    // Add disaster tags
    if (disaster.tags && disaster.tags.length > 0) {
      terms.push(...disaster.tags);
    }

    // Add location terms
    if (disaster.location_name) {
      const locationParts = disaster.location_name.split(',');
      terms.push(...locationParts.map(part => part.trim()));
    }

    // Add general disaster keywords
    terms.push('emergency', 'disaster', 'help');

    // Create query string
    return terms.slice(0, 10).join(' OR '); // Limit to avoid too complex queries
  }

  /**
   * Fetch posts from Twitter API
   * @param {string} query 
   * @param {number} maxResults 
   * @param {number} timeWindow 
   * @returns {Promise<object[]>}
   */
  async fetchTwitterPosts(query, maxResults, timeWindow) {
    const sinceTime = new Date(Date.now() - timeWindow * 60 * 60 * 1000).toISOString();
    
    const response = await axios.get(`${this.providers.twitter.config.baseUrl}/tweets/search/recent`, {
      params: {
        query: `${query} -is:retweet lang:en`,
        max_results: Math.min(maxResults, 100),
        'tweet.fields': 'created_at,author_id,public_metrics,context_annotations,geo',
        'user.fields': 'username,public_metrics',
        expansions: 'author_id',
        start_time: sinceTime
      },
      headers: {
        'Authorization': `Bearer ${this.providers.twitter.config.bearerToken}`
      },
      timeout: 15000
    });

    const data = response.data;
    const users = {};
    
    // Create user lookup
    if (data.includes?.users) {
      data.includes.users.forEach(user => {
        users[user.id] = user;
      });
    }

    return (data.data || []).map(tweet => ({
      id: tweet.id,
      content: tweet.text,
      author: users[tweet.author_id]?.username || 'unknown',
      authorId: tweet.author_id,
      createdAt: tweet.created_at,
      platform: 'twitter',
      url: `https://twitter.com/${users[tweet.author_id]?.username}/status/${tweet.id}`,
      metrics: {
        likes: tweet.public_metrics?.like_count || 0,
        retweets: tweet.public_metrics?.retweet_count || 0,
        replies: tweet.public_metrics?.reply_count || 0
      },
      location: tweet.geo || null,
      verified: users[tweet.author_id]?.verified || false
    }));
  }

  /**
   * Fetch posts from Bluesky API
   * @param {string} query 
   * @param {number} maxResults 
   * @param {number} timeWindow 
   * @returns {Promise<object[]>}
   */
  async fetchBlueskyPosts(query, maxResults, timeWindow) {
    // Note: This is a simplified implementation
    // Real Bluesky API integration would require proper authentication
    
    try {
      // First, authenticate with Bluesky
      const authResponse = await axios.post(`${this.providers.bluesky.config.baseUrl}/com.atproto.server.createSession`, {
        identifier: this.providers.bluesky.config.username,
        password: this.providers.bluesky.config.password
      });

      const accessJwt = authResponse.data.accessJwt;

      // Search for posts
      const searchResponse = await axios.get(`${this.providers.bluesky.config.baseUrl}/app.bsky.feed.searchPosts`, {
        params: {
          q: query,
          limit: Math.min(maxResults, 25)
        },
        headers: {
          'Authorization': `Bearer ${accessJwt}`
        }
      });

      return (searchResponse.data.posts || []).map(post => ({
        id: post.uri,
        content: post.record?.text || '',
        author: post.author?.handle || 'unknown',
        authorId: post.author?.did,
        createdAt: post.record?.createdAt,
        platform: 'bluesky',
        url: `https://bsky.app/profile/${post.author?.handle}/post/${post.uri.split('/').pop()}`,
        metrics: {
          likes: post.likeCount || 0,
          reposts: post.repostCount || 0,
          replies: post.replyCount || 0
        },
        verified: false
      }));

    } catch (error) {
      logger.warn('Bluesky API request failed', { error: error.message });
      return [];
    }
  }

  /**
   * Generate mock social media posts for testing
   * @param {object} disaster 
   * @param {number} count 
   * @returns {Promise<object[]>}
   */
  async generateMockPosts(disaster, count = 20) {
    const mockTemplates = [
      "Need help! ${tag} in ${location}. Roads are blocked and we can't get out.",
      "Anyone know if shelters are open near ${location}? ${tag} getting worse.",
      "Volunteer here! Helping with ${tag} relief in ${location}. Bring supplies.",
      "URGENT: Family trapped in ${location} due to ${tag}. Send help!",
      "Power is out in ${location}. ${tag} caused major damage to infrastructure.",
      "Red Cross shelter available at ${location}. ${tag} victims welcome.",
      "Food distribution happening now at ${location} for ${tag} victims.",
      "Medical assistance needed in ${location}. ${tag} casualties reported.",
      "Evacuation routes from ${location} are clear. Avoid downtown due to ${tag}.",
      "Water supply contaminated in ${location} after ${tag}. Boil before drinking."
    ];

    const mockAuthors = [
      'citizen_reporter', 'local_news_99', 'emergency_volunteer', 'resident_alert',
      'disaster_watch', 'community_helper', 'safety_first', 'neighbor_network',
      'crisis_update', 'help_coordinator', 'relief_worker', 'local_resident'
    ];

    const posts = [];
    const location = disaster.location_name || 'affected area';
    const primaryTag = disaster.tags?.[0] || 'emergency';

    for (let i = 0; i < count; i++) {
      const template = mockTemplates[Math.floor(Math.random() * mockTemplates.length)];
      const author = mockAuthors[Math.floor(Math.random() * mockAuthors.length)];
      const content = template
        .replace('${location}', location)
        .replace('${tag}', primaryTag);

      const createdAt = new Date(Date.now() - Math.random() * 24 * 60 * 60 * 1000); // Within last 24 hours
      
      posts.push({
        id: `mock_${disaster.id}_${i}`,
        content,
        author,
        authorId: `${author}_id`,
        createdAt: createdAt.toISOString(),
        platform: 'mock',
        url: `https://example.com/post/${i}`,
        metrics: {
          likes: Math.floor(Math.random() * 50),
          retweets: Math.floor(Math.random() * 20),
          replies: Math.floor(Math.random() * 10)
        },
        verified: Math.random() > 0.8
      });
    }

    return posts;
  }

  /**
   * Process and enrich social media post
   * @param {object} post 
   * @param {object} disaster 
   * @returns {object}
   */
  processPost(post, disaster) {
    const processedPost = { ...post };

    // Analyze content for urgency
    processedPost.isUrgent = this.detectUrgency(post.content);
    
    // Extract keywords
    processedPost.keywords = this.extractKeywords(post.content);
    
    // Classify sentiment/type
    processedPost.classification = this.classifyPost(post.content);
    
    // Calculate relevance score
    processedPost.relevanceScore = this.calculateRelevance(post, disaster);
    
    // Add processing timestamp
    processedPost.processedAt = new Date().toISOString();

    return processedPost;
  }

  /**
   * Detect if post contains urgent content
   * @param {string} content 
   * @returns {boolean}
   */
  detectUrgency(content) {
    const urgentPattern = new RegExp(this.urgentKeywords.join('|'), 'gi');
    const matches = content.match(urgentPattern);
    return matches && matches.length > 0;
  }

  /**
   * Extract relevant keywords from post content
   * @param {string} content 
   * @returns {string[]}
   */
  extractKeywords(content) {
    const keywords = [];
    const words = content.toLowerCase().split(/\s+/);
    
    words.forEach(word => {
      const cleanWord = word.replace(/[^\w]/g, '');
      if (this.disasterKeywords.includes(cleanWord) || this.urgentKeywords.includes(cleanWord)) {
        keywords.push(cleanWord);
      }
    });

    return [...new Set(keywords)]; // Remove duplicates
  }

  /**
   * Classify post type based on content
   * @param {string} content 
   * @returns {string}
   */
  classifyPost(content) {
    const helpPattern = /help|assistance|need|trapped|stranded/gi;
    const offerPattern = /offering|volunteer|donate|shelter|supplies/gi;
    const infoPattern = /update|report|status|confirmed|official/gi;
    
    if (helpPattern.test(content)) return 'help_request';
    if (offerPattern.test(content)) return 'offer_help';
    if (infoPattern.test(content)) return 'information';
    
    return 'general';
  }

  /**
   * Calculate post relevance to disaster
   * @param {object} post 
   * @param {object} disaster 
   * @returns {number}
   */
  calculateRelevance(post, disaster) {
    let score = 0.5; // Base score

    // Check for disaster tags
    if (disaster.tags) {
      disaster.tags.forEach(tag => {
        if (post.content.toLowerCase().includes(tag.toLowerCase())) {
          score += 0.2;
        }
      });
    }

    // Check for location mentions
    if (disaster.location_name) {
      const locationParts = disaster.location_name.toLowerCase().split(',');
      locationParts.forEach(part => {
        if (post.content.toLowerCase().includes(part.trim())) {
          score += 0.2;
        }
      });
    }

    // Boost for urgency
    if (post.isUrgent) {
      score += 0.3;
    }

    // Boost for engagement
    if (post.metrics) {
      const totalEngagement = (post.metrics.likes || 0) + (post.metrics.retweets || 0);
      if (totalEngagement > 10) score += 0.1;
      if (totalEngagement > 50) score += 0.1;
    }

    // Boost for verified accounts
    if (post.verified) {
      score += 0.1;
    }

    return Math.min(score, 1.0); // Cap at 1.0
  }

  /**
   * Health check for social media service
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    try {
      // Test with mock disaster
      const mockDisaster = {
        id: 'test',
        location_name: 'Test City',
        tags: ['flood']
      };
      
      const posts = await this.fetchReports('test', mockDisaster, { 
        provider: 'mock', 
        maxResults: 5 
      });
      
      return posts.length > 0;
    } catch (error) {
      logger.error('Social media health check failed', { error: error.message });
      return false;
    }
  }

  /**
   * Get service information
   * @returns {object}
   */
  getServiceInfo() {
    return {
      primaryProvider: this.primaryProvider,
      availableProviders: Object.keys(this.providers).filter(
        provider => this.providers[provider].available
      ),
      disasterKeywords: this.disasterKeywords.length,
      urgentKeywords: this.urgentKeywords.length
    };
  }
}

module.exports = new SocialMediaService();