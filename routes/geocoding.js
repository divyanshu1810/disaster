const express = require('express');
const Joi = require('joi');
const { requirePermission } = require('../middleware/auth');
const { catchAsync, APIError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const geocodingService = require('../services/geocoding');
const geminiService = require('../services/gemini');

const router = express.Router();

// Validation schemas
const geocodeSchema = Joi.object({
  location_name: Joi.string().min(2).max(500).required(),
  extract_from_description: Joi.string().max(5000).optional()
});

const reverseGeocodeSchema = Joi.object({
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required()
});

const extractLocationsSchema = Joi.object({
  description: Joi.string().min(10).max(5000).required(),
  auto_geocode: Joi.boolean().default(false)
});

/**
 * POST /geocoding/geocode - Convert location name to coordinates
 */
router.post('/geocode', requirePermission('read'), catchAsync(async (req, res) => {
  // Validate request body
  const { error, value } = geocodeSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  const { location_name, extract_from_description } = value;

  logger.info('Geocoding request', {
    userId: req.user.id,
    locationName: location_name,
    hasDescription: !!extract_from_description
  });

  try {
    const results = {
      primary_location: null,
      extracted_locations: [],
      geocoding_results: []
    };

    // If description is provided, extract locations first
    if (extract_from_description) {
      logger.info('Extracting locations from description', {
        userId: req.user.id,
        descriptionLength: extract_from_description.length
      });

      const extractedLocations = await geminiService.extractLocations(extract_from_description);
      results.extracted_locations = extractedLocations;

      // If we found locations, use the first one as primary if no location_name provided
      if (extractedLocations.length > 0 && !location_name) {
        results.primary_location = extractedLocations[0];
      }
    }

    // Use provided location_name or first extracted location
    const targetLocation = location_name || results.primary_location;

    if (!targetLocation) {
      throw new APIError('No location provided and none could be extracted from description', 400);
    }

    // Geocode the target location
    const geocodeResult = await geocodingService.geocode(targetLocation);
    
    if (!geocodeResult.success) {
      logger.warn('Geocoding failed', {
        location: targetLocation,
        error: geocodeResult.error,
        userId: req.user.id
      });
      
      throw new APIError(`Geocoding failed: ${geocodeResult.error || 'Unknown error'}`, 400);
    }

    results.geocoding_results = geocodeResult.results;
    results.primary_result = geocodeResult.results[0];
    results.provider = geocodeResult.provider;

    // Log successful geocoding
    logger.info('Geocoding successful', {
      userId: req.user.id,
      location: targetLocation,
      provider: geocodeResult.provider,
      resultCount: geocodeResult.results.length,
      confidence: geocodeResult.results[0]?.confidence
    });

    res.json({
      success: true,
      data: {
        input: {
          location_name: targetLocation,
          original_location_name: location_name,
          description_provided: !!extract_from_description
        },
        ...results,
        metadata: {
          provider: geocodeResult.provider,
          extracted_count: results.extracted_locations.length,
          geocoded_at: new Date().toISOString()
        }
      }
    });

  } catch (error) {
    logger.error('Geocoding request failed', {
      error: error.message,
      location: location_name,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Geocoding request failed', 500);
  }
}));

/**
 * POST /geocoding/reverse - Convert coordinates to location name
 */
router.post('/reverse', requirePermission('read'), catchAsync(async (req, res) => {
  // Validate request body
  const { error, value } = reverseGeocodeSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  const { lat, lng } = value;

  logger.info('Reverse geocoding request', {
    userId: req.user.id,
    coordinates: [lat, lng]
  });

  try {
    const result = await geocodingService.reverseGeocode(lat, lng);
    
    if (!result.success) {
      logger.warn('Reverse geocoding failed', {
        coordinates: [lat, lng],
        error: result.error,
        userId: req.user.id
      });
      
      throw new APIError(`Reverse geocoding failed: ${result.error || 'Unknown error'}`, 400);
    }

    logger.info('Reverse geocoding successful', {
      userId: req.user.id,
      coordinates: [lat, lng],
      provider: result.provider,
      locationName: result.locationName
    });

    res.json({
      success: true,
      data: {
        input: { lat, lng },
        location_name: result.locationName,
        formatted_address: result.formattedAddress,
        components: result.components,
        provider: result.provider,
        reverse_geocoded_at: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Reverse geocoding request failed', {
      error: error.message,
      coordinates: [lat, lng],
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Reverse geocoding request failed', 500);
  }
}));

/**
 * POST /geocoding/extract-locations - Extract locations from text using Gemini
 */
router.post('/extract-locations', requirePermission('read'), catchAsync(async (req, res) => {
  // Validate request body
  const { error, value } = extractLocationsSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  const { description, auto_geocode } = value;

  logger.info('Location extraction request', {
    userId: req.user.id,
    descriptionLength: description.length,
    autoGeocode: auto_geocode
  });

  try {
    // Extract locations using Gemini
    const extractedLocations = await geminiService.extractLocations(description);

    const results = {
      extracted_locations: extractedLocations,
      geocoded_locations: []
    };

    // If auto_geocode is enabled, geocode all extracted locations
    if (auto_geocode && extractedLocations.length > 0) {
      logger.info('Auto-geocoding extracted locations', {
        userId: req.user.id,
        locationCount: extractedLocations.length
      });

      const geocodePromises = extractedLocations.map(async (location) => {
        try {
          const geocodeResult = await geocodingService.geocode(location);
          return {
            location_name: location,
            geocoding_success: geocodeResult.success,
            coordinates: geocodeResult.success ? geocodeResult.results[0] : null,
            provider: geocodeResult.provider,
            error: geocodeResult.success ? null : geocodeResult.error
          };
        } catch (error) {
          return {
            location_name: location,
            geocoding_success: false,
            coordinates: null,
            provider: null,
            error: error.message
          };
        }
      });

      results.geocoded_locations = await Promise.all(geocodePromises);

      // Log geocoding results
      const successCount = results.geocoded_locations.filter(r => r.geocoding_success).length;
      logger.info('Auto-geocoding completed', {
        userId: req.user.id,
        totalLocations: extractedLocations.length,
        successfulGeocodes: successCount
      });
    }

    res.json({
      success: true,
      data: {
        input: {
          description: description.substring(0, 100) + (description.length > 100 ? '...' : ''),
          description_length: description.length,
          auto_geocode: auto_geocode
        },
        ...results,
        metadata: {
          extracted_count: extractedLocations.length,
          geocoded_count: results.geocoded_locations.length,
          successful_geocodes: results.geocoded_locations.filter(r => r.geocoding_success).length,
          extracted_at: new Date().toISOString()
        }
      }
    });

  } catch (error) {
    logger.error('Location extraction request failed', {
      error: error.message,
      descriptionLength: description.length,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Location extraction request failed', 500);
  }
}));

/**
 * GET /geocoding/batch-geocode - Batch geocode multiple locations
 */
router.post('/batch-geocode', requirePermission('read'), catchAsync(async (req, res) => {
  const batchSchema = Joi.object({
    locations: Joi.array().items(
      Joi.string().min(2).max(500)
    ).min(1).max(10).required() // Limit to 10 locations per batch
  });

  const { error, value } = batchSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  const { locations } = value;

  logger.info('Batch geocoding request', {
    userId: req.user.id,
    locationCount: locations.length
  });

  try {
    // Process all locations in parallel with rate limiting
    const geocodePromises = locations.map(async (location, index) => {
      // Add small delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, index * 100));
      
      try {
        const result = await geocodingService.geocode(location);
        return {
          location_name: location,
          success: result.success,
          results: result.success ? result.results : [],
          provider: result.provider,
          error: result.success ? null : result.error
        };
      } catch (error) {
        return {
          location_name: location,
          success: false,
          results: [],
          provider: null,
          error: error.message
        };
      }
    });

    const results = await Promise.all(geocodePromises);

    // Calculate statistics
    const successCount = results.filter(r => r.success).length;
    const totalResults = results.reduce((sum, r) => sum + r.results.length, 0);

    logger.info('Batch geocoding completed', {
      userId: req.user.id,
      totalLocations: locations.length,
      successfulGeocode: successCount,
      totalResults
    });

    res.json({
      success: true,
      data: {
        input: { locations },
        results,
        statistics: {
          total_locations: locations.length,
          successful_geocodes: successCount,
          failed_geocodes: locations.length - successCount,
          total_coordinate_results: totalResults,
          success_rate: (successCount / locations.length * 100).toFixed(1) + '%'
        },
        metadata: {
          geocoded_at: new Date().toISOString(),
          provider: geocodingService.getServiceInfo().provider
        }
      }
    });

  } catch (error) {
    logger.error('Batch geocoding request failed', {
      error: error.message,
      locationCount: locations.length,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Batch geocoding request failed', 500);
  }
}));

/**
 * GET /geocoding/service-info - Get geocoding service information
 */
router.get('/service-info', requirePermission('read'), catchAsync(async (req, res) => {
  try {
    const serviceInfo = geocodingService.getServiceInfo();
    const geminiHealthy = await geminiService.healthCheck();
    const geocodingHealthy = await geocodingService.healthCheck();

    res.json({
      success: true,
      data: {
        geocoding_service: {
          ...serviceInfo,
          healthy: geocodingHealthy
        },
        location_extraction_service: {
          provider: 'google_gemini',
          healthy: geminiHealthy,
          configured: !!process.env.GEMINI_API_KEY
        },
        capabilities: {
          geocoding: true,
          reverse_geocoding: true,
          batch_geocoding: true,
          location_extraction: true,
          auto_geocoding: true
        },
        limitations: {
          max_batch_size: 10,
          rate_limiting: true,
          cache_enabled: true
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

/**
 * POST /geocoding/validate-coordinates - Validate if coordinates are reasonable
 */
router.post('/validate-coordinates', requirePermission('read'), catchAsync(async (req, res) => {
  const validateSchema = Joi.object({
    lat: Joi.number().min(-90).max(90).required(),
    lng: Joi.number().min(-180).max(180).required(),
    expected_location: Joi.string().max(500).optional()
  });

  const { error, value } = validateSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  const { lat, lng, expected_location } = value;

  try {
    const validation = {
      coordinates_valid: true,
      in_ocean: false,
      reverse_geocode_result: null,
      location_match: null
    };

    // Basic coordinate validation
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      validation.coordinates_valid = false;
    }

    // Check if coordinates are in ocean (very basic check)
    // This is a simplified check - in production you might use a more sophisticated service
    if (Math.abs(lat) < 60 && (
      (lng > -30 && lng < 60 && lat > -40 && lat < 30) || // Atlantic Ocean rough area
      (lng > 60 && lng < 180 && lat > -40 && lat < 30) ||  // Pacific Ocean rough area
      (lng > -180 && lng < -30 && lat > -40 && lat < 30)   // Pacific Ocean rough area
    )) {
      validation.in_ocean = true;
    }

    // Reverse geocode to get location name
    if (validation.coordinates_valid) {
      try {
        const reverseResult = await geocodingService.reverseGeocode(lat, lng);
        validation.reverse_geocode_result = reverseResult;

        // If expected location provided, check for match
        if (expected_location && reverseResult.success) {
          const expectedLower = expected_location.toLowerCase();
          const actualLower = reverseResult.locationName.toLowerCase();
          validation.location_match = {
            expected: expected_location,
            actual: reverseResult.locationName,
            contains_expected: actualLower.includes(expectedLower),
            similarity_score: this.calculateSimilarity(expectedLower, actualLower)
          };
        }
      } catch (reverseError) {
        logger.warn('Reverse geocoding failed during validation', {
          coordinates: [lat, lng],
          error: reverseError.message
        });
      }
    }

    validation.overall_valid = validation.coordinates_valid && !validation.in_ocean;

    res.json({
      success: true,
      data: {
        input: { lat, lng, expected_location },
        validation,
        metadata: {
          validated_at: new Date().toISOString()
        }
      }
    });

  } catch (error) {
    logger.error('Coordinate validation failed', {
      error: error.message,
      coordinates: [lat, lng],
      userId: req.user.id
    });
    
    throw new APIError('Coordinate validation failed', 500);
  }
}));

/**
 * Helper function to calculate string similarity
 * @param {string} str1 
 * @param {string} str2 
 * @returns {number} Similarity score between 0 and 1
 */
function calculateSimilarity(str1, str2) {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) return 1.0;
  
  const distance = levenshteinDistance(longer, shorter);
  return (longer.length - distance) / longer.length;
}

/**
 * Calculate Levenshtein distance between two strings
 * @param {string} str1 
 * @param {string} str2 
 * @returns {number}
 */
function levenshteinDistance(str1, str2) {
  const matrix = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}

module.exports = router;