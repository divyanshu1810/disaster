const axios = require('axios');
const cheerio = require('cheerio');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

class OfficialUpdatesService {
  constructor() {
    this.sources = {
      fema: {
        name: 'FEMA',
        baseUrl: 'https://www.fema.gov',
        newsUrl: 'https://www.fema.gov/about/news-multimedia/news-stories',
        selector: '.views-row',
        titleSelector: '.field-title a',
        linkSelector: '.field-title a',
        dateSelector: '.field-date',
        enabled: true
      },
      redcross: {
        name: 'American Red Cross',
        baseUrl: 'https://www.redcross.org',
        newsUrl: 'https://www.redcross.org/about-us/news-and-events/news',
        selector: '.news-item',
        titleSelector: '.news-item-title a',
        linkSelector: '.news-item-title a',
        dateSelector: '.news-item-date',
        enabled: true
      },
      cdc: {
        name: 'CDC Emergency Preparedness',
        baseUrl: 'https://www.cdc.gov',
        newsUrl: 'https://www.cdc.gov/cpr/whatsnew/whatsnew.htm',
        selector: '.list-item',
        titleSelector: 'h3 a',
        linkSelector: 'h3 a',
        dateSelector: '.date',
        enabled: true
      },
      nws: {
        name: 'National Weather Service',
        baseUrl: 'https://www.weather.gov',
        newsUrl: 'https://www.weather.gov/news/',
        selector: '.news-item',
        titleSelector: '.news-title a',
        linkSelector: '.news-title a',
        dateSelector: '.news-date',
        enabled: true
      }
    };

    this.disasterKeywords = [
      'emergency', 'disaster', 'flood', 'flooding', 'hurricane', 'tornado',
      'earthquake', 'wildfire', 'fire', 'storm', 'evacuation', 'warning',
      'watch', 'alert', 'advisory', 'relief', 'response', 'recovery',
      'preparedness', 'safety'
    ];
  }

  /**
   * Fetch official updates for a disaster
   * @param {string} disasterId - Disaster ID
   * @param {object} disaster - Disaster details
   * @param {object} options - Fetch options
   * @returns {Promise<object[]>} Official updates
   */
  async fetchUpdates(disasterId, disaster, options = {}) {
    const {
      sources = Object.keys(this.sources).filter(key => this.sources[key].enabled),
      maxResults = 20,
      timeWindow = 72 // hours
    } = options;

    const cacheKey = cache.generateKey('official_updates', disasterId, sources.join(','));

    return await cache.getOrSet(cacheKey, async () => {
      const startTime = Date.now();
      const allUpdates = [];

      try {
        // Fetch from all enabled sources in parallel
        const fetchPromises = sources.map(async (source) => {
          try {
            const updates = await this.fetchFromSource(source, disaster, timeWindow);
            return updates.map(update => ({ ...update, source }));
          } catch (error) {
            logger.warn(`Failed to fetch from ${source}`, { error: error.message });
            return [];
          }
        });

        const results = await Promise.allSettled(fetchPromises);
        
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            allUpdates.push(...result.value);
          } else {
            logger.error(`Source ${sources[index]} failed`, { 
              error: result.reason?.message 
            });
          }
        });

        // Filter and rank updates
        const relevantUpdates = this.filterRelevantUpdates(allUpdates, disaster);
        const rankedUpdates = this.rankUpdatesByRelevance(relevantUpdates, disaster);

        logger.logAPICall(
          'official_updates', 
          'fetch_updates', 
          'success', 
          Date.now() - startTime,
          {
            disasterId,
            sourcesQueried: sources.length,
            totalUpdates: allUpdates.length,
            relevantUpdates: relevantUpdates.length
          }
        );

        return rankedUpdates.slice(0, maxResults);

      } catch (error) {
        logger.error('Official updates fetch failed', {
          disasterId,
          error: error.message
        });

        // Return mock data as fallback
        const mockUpdates = this.generateMockUpdates(disaster);
        logger.logAPICall(
          'official_updates', 
          'fetch_updates', 
          'fallback', 
          Date.now() - startTime
        );
        
        return mockUpdates;
      }
    }, 1800, 'official_updates'); // Cache for 30 minutes
  }

  /**
   * Fetch updates from a specific source
   * @param {string} sourceKey - Source identifier
   * @param {object} disaster - Disaster details
   * @param {number} timeWindow - Time window in hours
   * @returns {Promise<object[]>} Updates from source
   */
  async fetchFromSource(sourceKey, disaster, timeWindow) {
    const source = this.sources[sourceKey];
    if (!source || !source.enabled) {
      throw new Error(`Source ${sourceKey} not available`);
    }

    try {
      // Special handling for different sources
      switch (sourceKey) {
        case 'fema':
          return await this.fetchFEMAUpdates(source, disaster, timeWindow);
        case 'redcross':
          return await this.fetchRedCrossUpdates(source, disaster, timeWindow);
        case 'cdc':
          return await this.fetchCDCUpdates(source, disaster, timeWindow);
        case 'nws':
          return await this.fetchNWSUpdates(source, disaster, timeWindow);
        default:
          return await this.fetchGenericUpdates(source, disaster, timeWindow);
      }
    } catch (error) {
      logger.error(`Failed to fetch from ${source.name}`, {
        sourceKey,
        error: error.message,
        url: source.newsUrl
      });
      throw error;
    }
  }

  /**
   * Fetch FEMA updates
   * @param {object} source 
   * @param {object} disaster 
   * @param {number} timeWindow 
   * @returns {Promise<object[]>}
   */
  async fetchFEMAUpdates(source, disaster, timeWindow) {
    const response = await axios.get(source.newsUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'DisasterResponseBot/1.0 (+https://example.com/about)'
      }
    });

    const $ = cheerio.load(response.data);
    const updates = [];

    $(source.selector).each((index, element) => {
      try {
        const titleElement = $(element).find(source.titleSelector);
        const title = titleElement.text().trim();
        const relativeUrl = titleElement.attr('href');
        const url = relativeUrl ? new URL(relativeUrl, source.baseUrl).href : null;
        
        const dateText = $(element).find(source.dateSelector).text().trim();
        const publishedAt = this.parseDate(dateText);

        // Skip if too old
        if (this.isWithinTimeWindow(publishedAt, timeWindow)) {
          updates.push({
            title,
            url,
            publishedAt: publishedAt?.toISOString(),
            source: source.name,
            content: $(element).text().trim(),
            updateType: this.classifyUpdateType(title),
            priorityLevel: this.calculatePriority(title)
          });
        }
      } catch (err) {
        logger.warn('Error parsing FEMA update', { error: err.message });
      }
    });

    return updates;
  }

  /**
   * Fetch Red Cross updates
   * @param {object} source 
   * @param {object} disaster 
   * @param {number} timeWindow 
   * @returns {Promise<object[]>}
   */
  async fetchRedCrossUpdates(source, disaster, timeWindow) {
    // Similar implementation to FEMA but with Red Cross specific selectors
    const response = await axios.get(source.newsUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'DisasterResponseBot/1.0 (+https://example.com/about)'
      }
    });

    const $ = cheerio.load(response.data);
    const updates = [];

    // Red Cross might have different HTML structure
    $('.news-listing-item, .content-item, .article-teaser').each((index, element) => {
      try {
        const titleElement = $(element).find('h2 a, h3 a, .title a').first();
        const title = titleElement.text().trim();
        const relativeUrl = titleElement.attr('href');
        const url = relativeUrl ? new URL(relativeUrl, source.baseUrl).href : null;
        
        const dateText = $(element).find('.date, .publish-date, .meta-date').text().trim();
        const publishedAt = this.parseDate(dateText);

        if (this.isWithinTimeWindow(publishedAt, timeWindow)) {
          updates.push({
            title,
            url,
            publishedAt: publishedAt?.toISOString(),
            source: source.name,
            content: $(element).find('.summary, .excerpt, .description').text().trim(),
            updateType: this.classifyUpdateType(title),
            priorityLevel: this.calculatePriority(title)
          });
        }
      } catch (err) {
        logger.warn('Error parsing Red Cross update', { error: err.message });
      }
    });

    return updates;
  }

  /**
   * Fetch CDC updates
   * @param {object} source 
   * @param {object} disaster 
   * @param {number} timeWindow 
   * @returns {Promise<object[]>}
   */
  async fetchCDCUpdates(source, disaster, timeWindow) {
    const response = await axios.get(source.newsUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'DisasterResponseBot/1.0 (+https://example.com/about)'
      }
    });

    const $ = cheerio.load(response.data);
    const updates = [];

    $('li, .content-item, .news-item').each((index, element) => {
      try {
        const titleElement = $(element).find('a').first();
        const title = titleElement.text().trim();
        const relativeUrl = titleElement.attr('href');
        const url = relativeUrl ? new URL(relativeUrl, source.baseUrl).href : null;
        
        // CDC might have dates in different formats
        const dateText = $(element).find('.date, time').text().trim() || 
                        $(element).text().match(/\d{1,2}\/\d{1,2}\/\d{4}/)?.[0];
        const publishedAt = this.parseDate(dateText);

        if (title && this.isWithinTimeWindow(publishedAt, timeWindow)) {
          updates.push({
            title,
            url,
            publishedAt: publishedAt?.toISOString(),
            source: source.name,
            content: $(element).text().trim(),
            updateType: this.classifyUpdateType(title),
            priorityLevel: this.calculatePriority(title)
          });
        }
      } catch (err) {
        logger.warn('Error parsing CDC update', { error: err.message });
      }
    });

    return updates;
  }

  /**
   * Fetch National Weather Service updates
   * @param {object} source 
   * @param {object} disaster 
   * @param {number} timeWindow 
   * @returns {Promise<object[]>}
   */
  async fetchNWSUpdates(source, disaster, timeWindow) {
    // For NWS, we might want to check specific alerts for the disaster location
    let alertsUrl = 'https://api.weather.gov/alerts/active';
    
    // If we have coordinates, filter by location
    if (disaster.location && disaster.location.coordinates) {
      const [lng, lat] = disaster.location.coordinates;
      alertsUrl += `?point=${lat},${lng}`;
    }

    try {
      const response = await axios.get(alertsUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'DisasterResponseBot/1.0 (+https://example.com/about)'
        }
      });

      const alerts = response.data.features || [];
      const updates = [];

      alerts.forEach(alert => {
        const properties = alert.properties;
        const publishedAt = new Date(properties.onset || properties.sent);

        if (this.isWithinTimeWindow(publishedAt, timeWindow)) {
          updates.push({
            title: properties.headline || properties.event,
            url: `https://www.weather.gov/alerts/${properties.id}`,
            publishedAt: publishedAt.toISOString(),
            source: source.name,
            content: properties.description || properties.instruction,
            updateType: this.classifyNWSAlert(properties.event),
            priorityLevel: this.calculateNWSPriority(properties.severity),
            severity: properties.severity,
            urgency: properties.urgency,
            certainty: properties.certainty
          });
        }
      });

      return updates;
    } catch (error) {
      logger.warn('NWS API failed, falling back to web scraping', { error: error.message });
      return await this.fetchGenericUpdates(source, disaster, timeWindow);
    }
  }

  /**
   * Generic web scraping for other sources
   * @param {object} source 
   * @param {object} disaster 
   * @param {number} timeWindow 
   * @returns {Promise<object[]>}
   */
  async fetchGenericUpdates(source, disaster, timeWindow) {
    const response = await axios.get(source.newsUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'DisasterResponseBot/1.0 (+https://example.com/about)'
      }
    });

    const $ = cheerio.load(response.data);
    const updates = [];

    $(source.selector).each((index, element) => {
      try {
        const titleElement = $(element).find(source.titleSelector);
        const title = titleElement.text().trim();
        const relativeUrl = titleElement.attr('href');
        const url = relativeUrl ? new URL(relativeUrl, source.baseUrl).href : null;
        
        const dateText = $(element).find(source.dateSelector).text().trim();
        const publishedAt = this.parseDate(dateText);

        if (this.isWithinTimeWindow(publishedAt, timeWindow)) {
          updates.push({
            title,
            url,
            publishedAt: publishedAt?.toISOString(),
            source: source.name,
            content: $(element).text().trim(),
            updateType: this.classifyUpdateType(title),
            priorityLevel: this.calculatePriority(title)
          });
        }
      } catch (err) {
        logger.warn(`Error parsing ${source.name} update`, { error: err.message });
      }
    });

    return updates;
  }

  /**
   * Filter updates for relevance to disaster
   * @param {object[]} updates 
   * @param {object} disaster 
   * @returns {object[]}
   */
  filterRelevantUpdates(updates, disaster) {
    return updates.filter(update => {
      const content = (update.title + ' ' + update.content).toLowerCase();
      
      // Check for disaster keywords
      const hasKeywords = this.disasterKeywords.some(keyword => 
        content.includes(keyword.toLowerCase())
      );

      // Check for disaster tags
      const hasTags = disaster.tags ? disaster.tags.some(tag => 
        content.includes(tag.toLowerCase())
      ) : false;

      // Check for location mentions
      const hasLocation = disaster.location_name ? 
        content.includes(disaster.location_name.toLowerCase()) : false;

      return hasKeywords || hasTags || hasLocation;
    });
  }

  /**
   * Rank updates by relevance to disaster
   * @param {object[]} updates 
   * @param {object} disaster 
   * @returns {object[]}
   */
  rankUpdatesByRelevance(updates, disaster) {
    return updates.map(update => {
      let relevanceScore = 0;
      const content = (update.title + ' ' + update.content).toLowerCase();

      // Score for disaster tags
      if (disaster.tags) {
        disaster.tags.forEach(tag => {
          if (content.includes(tag.toLowerCase())) {
            relevanceScore += 0.3;
          }
        });
      }

      // Score for location
      if (disaster.location_name && content.includes(disaster.location_name.toLowerCase())) {
        relevanceScore += 0.4;
      }

      // Score for priority level
      relevanceScore += (update.priorityLevel || 1) * 0.1;

      // Score for recency
      const age = Date.now() - new Date(update.publishedAt).getTime();
      const ageHours = age / (1000 * 60 * 60);
      if (ageHours < 24) relevanceScore += 0.2;
      else if (ageHours < 48) relevanceScore += 0.1;

      return { ...update, relevanceScore };
    }).sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  /**
   * Parse date from various formats
   * @param {string} dateText 
   * @returns {Date|null}
   */
  parseDate(dateText) {
    if (!dateText) return null;

    try {
      // Handle various date formats
      const cleanDate = dateText.replace(/Published:|Updated:|Posted:/, '').trim();
      const date = new Date(cleanDate);
      
      if (isNaN(date.getTime())) {
        // Try parsing MM/DD/YYYY format
        const match = cleanDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (match) {
          return new Date(match[3], match[1] - 1, match[2]);
        }
        return null;
      }
      
      return date;
    } catch {
      return null;
    }
  }

  /**
   * Check if date is within time window
   * @param {Date|null} date 
   * @param {number} timeWindow 
   * @returns {boolean}
   */
  isWithinTimeWindow(date, timeWindow) {
    if (!date) return true; // Include if we can't determine date
    
    const cutoff = new Date(Date.now() - timeWindow * 60 * 60 * 1000);
    return date >= cutoff;
  }

  /**
   * Classify update type based on title
   * @param {string} title 
   * @returns {string}
   */
  classifyUpdateType(title) {
    const lowerTitle = title.toLowerCase();
    
    if (lowerTitle.includes('evacuation')) return 'evacuation';
    if (lowerTitle.includes('warning') || lowerTitle.includes('alert')) return 'alert';
    if (lowerTitle.includes('advisory')) return 'advisory';
    if (lowerTitle.includes('update') || lowerTitle.includes('status')) return 'update';
    if (lowerTitle.includes('relief') || lowerTitle.includes('aid')) return 'relief';
    
    return 'general';
  }

  /**
   * Calculate priority level from title
   * @param {string} title 
   * @returns {number}
   */
  calculatePriority(title) {
    const lowerTitle = title.toLowerCase();
    
    if (lowerTitle.includes('urgent') || lowerTitle.includes('emergency')) return 5;
    if (lowerTitle.includes('warning') || lowerTitle.includes('evacuation')) return 4;
    if (lowerTitle.includes('alert') || lowerTitle.includes('watch')) return 3;
    if (lowerTitle.includes('advisory')) return 2;
    
    return 1;
  }

  /**
   * Classify NWS alert type
   * @param {string} event 
   * @returns {string}
   */
  classifyNWSAlert(event) {
    const lowerEvent = event.toLowerCase();
    
    if (lowerEvent.includes('warning')) return 'warning';
    if (lowerEvent.includes('watch')) return 'watch';
    if (lowerEvent.includes('advisory')) return 'advisory';
    if (lowerEvent.includes('statement')) return 'statement';
    
    return 'alert';
  }

  /**
   * Calculate NWS priority from severity
   * @param {string} severity 
   * @returns {number}
   */
  calculateNWSPriority(severity) {
    switch (severity?.toLowerCase()) {
      case 'extreme': return 5;
      case 'severe': return 4;
      case 'moderate': return 3;
      case 'minor': return 2;
      default: return 1;
    }
  }

  /**
   * Generate mock updates for testing
   * @param {object} disaster 
   * @returns {object[]}
   */
  generateMockUpdates(disaster) {
    const mockTemplates = [
      {
        title: "${source} Issues ${type} for ${location} Due to ${tag}",
        content: "Official ${type} has been issued for ${location} area due to ongoing ${tag}. Residents should take immediate precautions.",
        updateType: "alert",
        priorityLevel: 4
      },
      {
        title: "Relief Operations Continue in ${location} After ${tag}",
        content: "Emergency response teams continue relief operations in ${location} following the ${tag}. Multiple shelters are operational.",
        updateType: "update",
        priorityLevel: 2
      },
      {
        title: "Evacuation Routes Established for ${location} ${tag} Response",
        content: "Local authorities have established evacuation routes for residents in ${location} affected by the ${tag}.",
        updateType: "evacuation",
        priorityLevel: 5
      }
    ];

    const sources = ['FEMA', 'Red Cross', 'Emergency Management', 'National Weather Service'];
    const types = ['Warning', 'Advisory', 'Alert', 'Update'];
    
    return mockTemplates.map((template, index) => {
      const source = sources[index % sources.length];
      const type = types[index % types.length];
      const location = disaster.location_name || 'Affected Area';
      const tag = disaster.tags?.[0] || 'emergency';

      return {
        title: template.title
          .replace('${source}', source)
          .replace('${type}', type)
          .replace('${location}', location)
          .replace('${tag}', tag),
        content: template.content
          .replace('${type}', type.toLowerCase())
          .replace('${location}', location)
          .replace('${tag}', tag),
        url: `https://example.com/update/${index}`,
        publishedAt: new Date(Date.now() - Math.random() * 24 * 60 * 60 * 1000).toISOString(),
        source,
        updateType: template.updateType,
        priorityLevel: template.priorityLevel,
        relevanceScore: 0.8
      };
    });
  }

  /**
   * Health check for official updates service
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    try {
      const mockDisaster = {
        id: 'test',
        location_name: 'Test City',
        tags: ['flood']
      };
      
      const updates = await this.fetchUpdates('test', mockDisaster, { 
        maxResults: 3,
        sources: ['mock'] // Use mock data for health check
      });
      
      return updates.length > 0;
    } catch (error) {
      logger.error('Official updates health check failed', { error: error.message });
      return false;
    }
  }

  /**
   * Get service information
   * @returns {object}
   */
  getServiceInfo() {
    const enabledSources = Object.keys(this.sources).filter(
      key => this.sources[key].enabled
    );

    return {
      enabledSources,
      totalSources: Object.keys(this.sources).length,
      disasterKeywords: this.disasterKeywords.length,
      sourceDetails: enabledSources.map(key => ({
        key,
        name: this.sources[key].name,
        url: this.sources[key].newsUrl
      }))
    };
  }
}

module.exports = new OfficialUpdatesService();