const axios = require('axios');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

class GeocodingService {
  constructor() {
    // Determine which geocoding service to use based on available API keys
    this.provider = this.selectProvider();
    this.setupProviderConfig();
  }

  /**
   * Select the best available geocoding provider
   * @returns {string} Provider name
   */
  selectProvider() {
    if (process.env.GOOGLE_MAPS_API_KEY) {
      return 'google';
    } else if (process.env.MAPBOX_ACCESS_TOKEN) {
      return 'mapbox';
    } else {
      return 'osm'; // OpenStreetMap (free, no key required)
    }
  }

  /**
   * Setup provider-specific configuration
   */
  setupProviderConfig() {
    this.config = {
      google: {
        baseUrl: 'https://maps.googleapis.com/maps/api/geocode/json',
        apiKey: process.env.GOOGLE_MAPS_API_KEY,
        rateLimitDelay: 50 // 20 requests per second
      },
      mapbox: {
        baseUrl: 'https://api.mapbox.com/geocoding/v5/mapbox.places',
        apiKey: process.env.MAPBOX_ACCESS_TOKEN,
        rateLimitDelay: 100 // 10 requests per second
      },
      osm: {
        baseUrl: 'https://nominatim.openstreetmap.org/search',
        apiKey: null,
        rateLimitDelay: 1000 // 1 request per second (be respectful)
      }
    };
  }

  /**
   * Convert location name to latitude/longitude coordinates
   * @param {string} locationName - Location name to geocode
   * @returns {Promise<object>} Geocoding result with lat/lng
   */
  async geocode(locationName) {
    const cacheKey = cache.generateKey('geocoding', this.provider, locationName);
    
    return await cache.getOrSet(cacheKey, async () => {
      const startTime = Date.now();
      
      try {
        let result;
        
        switch (this.provider) {
          case 'google':
            result = await this.geocodeGoogle(locationName);
            break;
          case 'mapbox':
            result = await this.geocodeMapbox(locationName);
            break;
          case 'osm':
            result = await this.geocodeOSM(locationName);
            break;
          default:
            throw new Error(`Unknown geocoding provider: ${this.provider}`);
        }

        logger.logAPICall(
          `geocoding_${this.provider}`, 
          'geocode', 
          'success', 
          Date.now() - startTime,
          {
            locationName,
            resultCount: result.results?.length || 0,
            primaryResult: result.results?.[0]
          }
        );

        return result;

      } catch (error) {
        logger.error('Geocoding failed', {
          provider: this.provider,
          locationName,
          error: error.message
        });

        // Fallback to mock coordinates for testing
        const fallbackResult = this.createFallbackResult(locationName);
        logger.logAPICall(
          `geocoding_${this.provider}`, 
          'geocode', 
          'fallback', 
          Date.now() - startTime
        );
        
        return fallbackResult;
      }
    }, 86400, `geocoding_${this.provider}`); // Cache for 24 hours
  }

  /**
   * Reverse geocode - convert lat/lng to location name
   * @param {number} lat - Latitude
   * @param {number} lng - Longitude
   * @returns {Promise<object>} Reverse geocoding result
   */
  async reverseGeocode(lat, lng) {
    const cacheKey = cache.generateKey('reverse_geocoding', this.provider, `${lat},${lng}`);
    
    return await cache.getOrSet(cacheKey, async () => {
      const startTime = Date.now();
      
      try {
        let result;
        
        switch (this.provider) {
          case 'google':
            result = await this.reverseGeocodeGoogle(lat, lng);
            break;
          case 'mapbox':
            result = await this.reverseGeocodeMapbox(lat, lng);
            break;
          case 'osm':
            result = await this.reverseGeocodeOSM(lat, lng);
            break;
          default:
            throw new Error(`Unknown geocoding provider: ${this.provider}`);
        }

        logger.logAPICall(
          `reverse_geocoding_${this.provider}`, 
          'reverse_geocode', 
          'success', 
          Date.now() - startTime,
          { lat, lng }
        );

        return result;

      } catch (error) {
        logger.error('Reverse geocoding failed', {
          provider: this.provider,
          lat, lng,
          error: error.message
        });

        // Fallback result
        const fallbackResult = {
          success: false,
          locationName: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
          formattedAddress: `Coordinates: ${lat.toFixed(6)}, ${lng.toFixed(6)}`,
          error: error.message
        };
        
        return fallbackResult;
      }
    }, 86400, `reverse_geocoding_${this.provider}`); // Cache for 24 hours
  }

  /**
   * Google Maps Geocoding
   * @param {string} locationName 
   * @returns {Promise<object>}
   */
  async geocodeGoogle(locationName) {
    const response = await axios.get(this.config.google.baseUrl, {
      params: {
        address: locationName,
        key: this.config.google.apiKey
      },
      timeout: 10000
    });

    const data = response.data;
    
    if (data.status !== 'OK') {
      throw new Error(`Google Geocoding API error: ${data.status}`);
    }

    return {
      success: true,
      provider: 'google',
      results: data.results.map(result => ({
        lat: result.geometry.location.lat,
        lng: result.geometry.location.lng,
        formattedAddress: result.formatted_address,
        placeId: result.place_id,
        types: result.types,
        confidence: this.calculateGoogleConfidence(result)
      }))
    };
  }

  /**
   * Google Maps Reverse Geocoding
   * @param {number} lat 
   * @param {number} lng 
   * @returns {Promise<object>}
   */
  async reverseGeocodeGoogle(lat, lng) {
    const response = await axios.get(this.config.google.baseUrl, {
      params: {
        latlng: `${lat},${lng}`,
        key: this.config.google.apiKey
      },
      timeout: 10000
    });

    const data = response.data;
    
    if (data.status !== 'OK') {
      throw new Error(`Google Reverse Geocoding API error: ${data.status}`);
    }

    const primaryResult = data.results[0];
    
    return {
      success: true,
      provider: 'google',
      locationName: this.extractLocationName(primaryResult.formatted_address),
      formattedAddress: primaryResult.formatted_address,
      components: primaryResult.address_components
    };
  }

  /**
   * Mapbox Geocoding
   * @param {string} locationName 
   * @returns {Promise<object>}
   */
  async geocodeMapbox(locationName) {
    const encodedLocation = encodeURIComponent(locationName);
    const url = `${this.config.mapbox.baseUrl}/${encodedLocation}.json`;
    
    const response = await axios.get(url, {
      params: {
        access_token: this.config.mapbox.apiKey,
        limit: 5
      },
      timeout: 10000
    });

    const data = response.data;
    
    return {
      success: true,
      provider: 'mapbox',
      results: data.features.map(feature => ({
        lat: feature.center[1], // Mapbox returns [lng, lat]
        lng: feature.center[0],
        formattedAddress: feature.place_name,
        placeId: feature.id,
        types: feature.place_type,
        confidence: feature.relevance || 0.5
      }))
    };
  }

  /**
   * Mapbox Reverse Geocoding
   * @param {number} lat 
   * @param {number} lng 
   * @returns {Promise<object>}
   */
  async reverseGeocodeMapbox(lat, lng) {
    const url = `${this.config.mapbox.baseUrl}/${lng},${lat}.json`;
    
    const response = await axios.get(url, {
      params: {
        access_token: this.config.mapbox.apiKey
      },
      timeout: 10000
    });

    const data = response.data;
    const primaryResult = data.features[0];
    
    return {
      success: true,
      provider: 'mapbox',
      locationName: this.extractLocationName(primaryResult.place_name),
      formattedAddress: primaryResult.place_name,
      components: primaryResult.context
    };
  }

  /**
   * OpenStreetMap Geocoding (Nominatim)
   * @param {string} locationName 
   * @returns {Promise<object>}
   */
  async geocodeOSM(locationName) {
    // Add delay to respect OSM rate limits
    await this.rateLimitDelay(this.config.osm.rateLimitDelay);
    
    const response = await axios.get(this.config.osm.baseUrl, {
      params: {
        q: locationName,
        format: 'json',
        limit: 5,
        addressdetails: 1
      },
      headers: {
        'User-Agent': 'DisasterResponseApp/1.0 (contact@example.com)' // Required by OSM
      },
      timeout: 15000
    });

    const data = response.data;
    
    return {
      success: true,
      provider: 'osm',
      results: data.map(result => ({
        lat: parseFloat(result.lat),
        lng: parseFloat(result.lon),
        formattedAddress: result.display_name,
        placeId: result.place_id,
        types: [result.type],
        confidence: parseFloat(result.importance) || 0.5
      }))
    };
  }

  /**
   * OpenStreetMap Reverse Geocoding
   * @param {number} lat 
   * @param {number} lng 
   * @returns {Promise<object>}
   */
  async reverseGeocodeOSM(lat, lng) {
    await this.rateLimitDelay(this.config.osm.rateLimitDelay);
    
    const response = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: {
        lat,
        lon: lng,
        format: 'json',
        addressdetails: 1
      },
      headers: {
        'User-Agent': 'DisasterResponseApp/1.0 (contact@example.com)'
      },
      timeout: 15000
    });

    const data = response.data;
    
    return {
      success: true,
      provider: 'osm',
      locationName: this.extractLocationName(data.display_name),
      formattedAddress: data.display_name,
      components: data.address
    };
  }

  /**
   * Calculate confidence score for Google results
   * @param {object} result 
   * @returns {number}
   */
  calculateGoogleConfidence(result) {
    if (result.geometry.location_type === 'ROOFTOP') return 0.9;
    if (result.geometry.location_type === 'RANGE_INTERPOLATED') return 0.8;
    if (result.geometry.location_type === 'GEOMETRIC_CENTER') return 0.7;
    return 0.6;
  }

  /**
   * Extract a clean location name from formatted address
   * @param {string} formattedAddress 
   * @returns {string}
   */
  extractLocationName(formattedAddress) {
    // Try to extract the primary location (usually first part before comma)
    const parts = formattedAddress.split(',');
    return parts[0].trim();
  }

  /**
   * Create fallback result when geocoding fails
   * @param {string} locationName 
   * @returns {object}
   */
  createFallbackResult(locationName) {
    // Create mock coordinates based on common locations
    const mockLocations = {
      'manhattan': { lat: 40.7831, lng: -73.9712 },
      'manhattan, nyc': { lat: 40.7831, lng: -73.9712 },
      'new york': { lat: 40.7128, lng: -74.0060 },
      'los angeles': { lat: 34.0522, lng: -118.2437 },
      'chicago': { lat: 41.8781, lng: -87.6298 },
      'houston': { lat: 29.7604, lng: -95.3698 },
      'default': { lat: 40.7128, lng: -74.0060 } // Default to NYC
    };

    const key = locationName.toLowerCase();
    const coords = mockLocations[key] || mockLocations['default'];
    
    return {
      success: false,
      provider: 'fallback',
      results: [{
        lat: coords.lat,
        lng: coords.lng,
        formattedAddress: locationName,
        placeId: `fallback_${Date.now()}`,
        types: ['fallback'],
        confidence: 0.3
      }],
      warning: 'Using fallback coordinates - geocoding service unavailable'
    };
  }

  /**
   * Rate limiting delay
   * @param {number} ms 
   * @returns {Promise}
   */
  async rateLimitDelay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Health check for geocoding service
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    try {
      const result = await this.geocode('New York, NY');
      return result.success || result.results?.length > 0;
    } catch (error) {
      logger.error('Geocoding health check failed', { 
        provider: this.provider,
        error: error.message 
      });
      return false;
    }
  }

  /**
   * Get service information
   * @returns {object}
   */
  getServiceInfo() {
    return {
      provider: this.provider,
      configured: !!this.config[this.provider].apiKey,
      rateLimitDelay: this.config[this.provider].rateLimitDelay
    };
  }
}

module.exports = new GeocodingService();