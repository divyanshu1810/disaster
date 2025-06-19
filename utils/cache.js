const { supabase } = require('../config/supabase');
const logger = require('./logger');

class CacheManager {
  constructor() {
    this.defaultTTL = parseInt(process.env.CACHE_TTL) || 3600; // 1 hour default
  }

  /**
   * Generate cache key
   * @param {string} service - Service name (e.g., 'gemini', 'maps', 'twitter')
   * @param {string} operation - Operation type (e.g., 'geocode', 'extract_location')
   * @param {string} input - Input data (will be hashed if too long)
   * @returns {string} Cache key
   */
  generateKey(service, operation, input) {
    const inputKey = typeof input === 'string' 
      ? input.length > 100 ? this.hashString(input) : input
      : JSON.stringify(input);
    
    return `${service}:${operation}:${inputKey}`.toLowerCase();
  }

  /**
   * Simple hash function for long strings
   * @param {string} str - String to hash
   * @returns {string} Hash
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Get value from cache
   * @param {string} key - Cache key
   * @returns {Promise<any|null>} Cached value or null if not found/expired
   */
  async get(key) {
    try {
      const { data, error } = await supabase
        .from('cache')
        .select('value, expires_at, hit_count')
        .eq('key', key)
        .single();

      if (error) {
        if (error.code === 'PGRST116') { // No rows returned
          logger.logCacheAction('miss', key, false);
          return null;
        }
        throw error;
      }

      // Check if expired
      if (new Date(data.expires_at) < new Date()) {
        logger.logCacheAction('expired', key, false);
        await this.delete(key);
        return null;
      }

      // Increment hit count
      await supabase
        .from('cache')
        .update({ hit_count: (data.hit_count || 0) + 1 })
        .eq('key', key);

      logger.logCacheAction('hit', key, true, {
        hitCount: (data.hit_count || 0) + 1
      });

      return data.value;
    } catch (error) {
      logger.error('Cache get error', {
        key,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Set value in cache
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttl - Time to live in seconds (optional)
   * @param {string} source - Source service (optional)
   * @returns {Promise<boolean>} Success status
   */
  async set(key, value, ttl = null, source = null) {
    try {
      const expiresAt = new Date(Date.now() + (ttl || this.defaultTTL) * 1000);
      
      const { error } = await supabase
        .from('cache')
        .upsert({
          key,
          value,
          expires_at: expiresAt.toISOString(),
          source,
          hit_count: 0
        });

      if (error) {
        throw error;
      }

      logger.logCacheAction('set', key, false, {
        ttl: ttl || this.defaultTTL,
        source,
        expiresAt: expiresAt.toISOString()
      });

      return true;
    } catch (error) {
      logger.error('Cache set error', {
        key,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Delete value from cache
   * @param {string} key - Cache key
   * @returns {Promise<boolean>} Success status
   */
  async delete(key) {
    try {
      const { error } = await supabase
        .from('cache')
        .delete()
        .eq('key', key);

      if (error) {
        throw error;
      }

      logger.logCacheAction('delete', key, false);
      return true;
    } catch (error) {
      logger.error('Cache delete error', {
        key,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Clean expired cache entries
   * @returns {Promise<number>} Number of deleted entries
   */
  async cleanExpired() {
    try {
      const { data, error } = await supabase
        .rpc('clean_expired_cache');

      if (error) {
        throw error;
      }

      const deletedCount = data || 0;
      logger.info('Cache cleanup completed', {
        deletedEntries: deletedCount
      });

      return deletedCount;
    } catch (error) {
      logger.error('Cache cleanup error', {
        error: error.message
      });
      return 0;
    }
  }

  /**
   * Get or set pattern - common caching pattern
   * @param {string} key - Cache key
   * @param {Function} fetchFunction - Function to fetch data if not cached
   * @param {number} ttl - Time to live in seconds (optional)
   * @param {string} source - Source service (optional)
   * @returns {Promise<any>} Cached or fetched value
   */
  async getOrSet(key, fetchFunction, ttl = null, source = null) {
    // Try to get from cache first
    const cachedValue = await this.get(key);
    if (cachedValue !== null) {
      return cachedValue;
    }

    // If not in cache, fetch and cache the result
    try {
      const fetchedValue = await fetchFunction();
      if (fetchedValue !== null && fetchedValue !== undefined) {
        await this.set(key, fetchedValue, ttl, source);
      }
      return fetchedValue;
    } catch (error) {
      logger.error('Failed to fetch and cache data', {
        key,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Clear all cache entries for a specific source
   * @param {string} source - Source service
   * @returns {Promise<number>} Number of deleted entries
   */
  async clearBySource(source) {
    try {
      const { data, error } = await supabase
        .from('cache')
        .delete()
        .eq('source', source);

      if (error) {
        throw error;
      }

      logger.info('Cache cleared by source', {
        source,
        deletedEntries: data?.length || 0
      });

      return data?.length || 0;
    } catch (error) {
      logger.error('Cache clear by source error', {
        source,
        error: error.message
      });
      return 0;
    }
  }

  /**
   * Get cache statistics
   * @returns {Promise<object>} Cache statistics
   */
  async getStats() {
    try {
      const { data, error } = await supabase
        .from('cache')
        .select('source, hit_count, expires_at, created_at')
        .order('created_at', { ascending: false });

      if (error) {
        throw error;
      }

      const stats = {
        totalEntries: data.length,
        bySource: {},
        totalHits: 0,
        expiredEntries: 0
      };

      const now = new Date();
      
      data.forEach(entry => {
        // Count by source
        if (entry.source) {
          stats.bySource[entry.source] = (stats.bySource[entry.source] || 0) + 1;
        }

        // Total hits
        stats.totalHits += entry.hit_count || 0;

        // Count expired entries
        if (new Date(entry.expires_at) < now) {
          stats.expiredEntries++;
        }
      });

      return stats;
    } catch (error) {
      logger.error('Failed to get cache stats', {
        error: error.message
      });
      return null;
    }
  }
}

// Export singleton instance
module.exports = new CacheManager();