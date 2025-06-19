const express = require('express');
const Joi = require('joi');
const { supabase } = require('../config/supabase');
const { requirePermission } = require('../middleware/auth');
const { catchAsync, APIError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const geocodingService = require('../services/geocoding');

const router = express.Router();

// Validation schemas
const resourceSchema = Joi.object({
  disaster_id: Joi.string().uuid().optional(),
  name: Joi.string().min(2).max(255).required(),
  location_name: Joi.string().min(2).max(500).required(),
  type: Joi.string().valid(
    'shelter', 'food', 'water', 'medical', 'rescue', 'transport', 
    'power', 'communication', 'other'
  ).required(),
  description: Joi.string().max(1000).optional(),
  capacity: Joi.number().integer().min(0).optional(),
  current_usage: Joi.number().integer().min(0).optional(),
  contact_info: Joi.object().optional(),
  availability_hours: Joi.object().optional(),
  is_available: Joi.boolean().default(true)
});

const nearbyResourcesSchema = Joi.object({
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required(),
  distance_km: Joi.number().min(0.1).max(100).default(10),
  resource_types: Joi.array().items(
    Joi.string().valid(
      'shelter', 'food', 'water', 'medical', 'rescue', 
      'transport', 'power', 'communication', 'other'
    )
  ).optional(),
  disaster_id: Joi.string().uuid().optional(),
  limit: Joi.number().integer().min(1).max(100).default(20),
  include_unavailable: Joi.boolean().default(false)
});

/**
 * GET /resources/disasters/:id/nearby - Get resources near a disaster
 */
router.get('/disasters/:id/nearby', requirePermission('read'), catchAsync(async (req, res) => {
  const { id: disasterId } = req.params;
  const {
    distance_km = 10,
    resource_types,
    limit = 20,
    include_unavailable = false
  } = req.query;

  logger.info('Fetching nearby resources for disaster', {
    disasterId,
    distanceKm: distance_km,
    resourceTypes: resource_types,
    userId: req.user.id
  });

  try {
    // Get disaster location
    const { data: disaster, error: disasterError } = await supabase
      .from('disasters')
      .select('id, title, location_name, location')
      .eq('id', disasterId)
      .single();

    if (disasterError) {
      if (disasterError.code === 'PGRST116') {
        throw new APIError('Disaster not found', 404);
      }
      throw new APIError('Failed to fetch disaster', 500);
    }

    if (!disaster.location) {
      throw new APIError('Disaster location not available for proximity search', 400);
    }

    // Extract coordinates from PostGIS geography
    const { data: coordsResult, error: coordsError } = await supabase
      .rpc('st_x', { geog: disaster.location })
      .single();

    if (coordsError) {
      throw new APIError('Failed to extract disaster coordinates', 500);
    }

    // Get longitude and latitude
    const { data: lngResult } = await supabase.rpc('st_x', { geog: disaster.location });
    const { data: latResult } = await supabase.rpc('st_y', { geog: disaster.location });

    const disasterLng = lngResult;
    const disasterLat = latResult;

    // Find nearby resources using PostGIS
    const distanceMeters = parseFloat(distance_km) * 1000;

    let query = supabase
      .from('resources')
      .select(`
        *,
        distance:location->>${disasterLng},${disasterLat}
      `)
      .not('location', 'is', null);

    // Filter by resource types if specified
    if (resource_types) {
      const types = Array.isArray(resource_types) ? resource_types : [resource_types];
      query = query.in('type', types);
    }

    // Filter by availability
    if (include_unavailable !== 'true') {
      query = query.eq('is_available', true);
    }

    // Apply distance filter using raw SQL
    const { data: nearbyResources, error: resourcesError } = await supabase
      .rpc('find_nearby_resources', {
        disaster_lat: disasterLat,
        disaster_lng: disasterLng,
        distance_meters: distanceMeters,
        resource_types: resource_types ? (Array.isArray(resource_types) ? resource_types : [resource_types]) : null
      });

    if (resourcesError) {
      logger.error('Nearby resources query failed', {
        error: resourcesError.message,
        disasterId,
        coordinates: [disasterLat, disasterLng]
      });
      throw new APIError('Failed to fetch nearby resources', 500);
    }

    // Limit results
    const limitedResources = nearbyResources.slice(0, parseInt(limit));

    // Group resources by type for easier consumption
    const resourcesByType = {};
    limitedResources.forEach(resource => {
      if (!resourcesByType[resource.type]) {
        resourcesByType[resource.type] = [];
      }
      resourcesByType[resource.type].push(resource);
    });

    // Emit real-time update
    req.io.to(`disaster_${disasterId}`).emit('resources_updated', {
      disasterId,
      nearbyResourcesCount: limitedResources.length,
      resourceTypes: Object.keys(resourcesByType),
      searchRadius: distance_km
    });

    logger.logResourceAction('nearby_search', null, disaster.location_name, {
      disasterId,
      distanceKm: distance_km,
      resultsCount: limitedResources.length
    });

    res.json({
      success: true,
      data: {
        disaster: {
          id: disaster.id,
          title: disaster.title,
          location_name: disaster.location_name,
          coordinates: [disasterLat, disasterLng]
        },
        resources: limitedResources,
        resources_by_type: resourcesByType,
        search_parameters: {
          center: [disasterLat, disasterLng],
          radius_km: parseFloat(distance_km),
          resource_types: resource_types || 'all',
          include_unavailable: include_unavailable === 'true'
        },
        metadata: {
          total_found: limitedResources.length,
          search_radius_km: parseFloat(distance_km),
          types_found: Object.keys(resourcesByType),
          searched_at: new Date().toISOString()
        }
      }
    });

  } catch (error) {
    logger.error('Nearby resources fetch failed', {
      disasterId,
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to fetch nearby resources', 500);
  }
}));

/**
 * POST /resources/search/nearby - Search for resources near specific coordinates
 */
router.post('/search/nearby', requirePermission('read'), catchAsync(async (req, res) => {
  // Validate request body
  const { error, value } = nearbyResourcesSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  const {
    lat,
    lng,
    distance_km,
    resource_types,
    disaster_id,
    limit,
    include_unavailable
  } = value;

  logger.info('Searching for nearby resources', {
    coordinates: [lat, lng],
    distanceKm: distance_km,
    resourceTypes: resource_types,
    disasterId: disaster_id,
    userId: req.user.id
  });

  try {
    const distanceMeters = distance_km * 1000;

    // Use PostGIS function to find nearby resources
    const { data: nearbyResources, error: resourcesError } = await supabase
      .rpc('find_nearby_resources', {
        disaster_lat: lat,
        disaster_lng: lng,
        distance_meters: distanceMeters,
        resource_types: resource_types
      });

    if (resourcesError) {
      logger.error('Nearby resources search failed', {
        error: resourcesError.message,
        coordinates: [lat, lng]
      });
      throw new APIError('Failed to search nearby resources', 500);
    }

    // Filter by availability if requested
    let filteredResources = nearbyResources;
    if (!include_unavailable) {
      filteredResources = nearbyResources.filter(r => r.is_available);
    }

    // Filter by disaster if specified
    if (disaster_id) {
      filteredResources = filteredResources.filter(r => 
        r.disaster_id === disaster_id || r.disaster_id === null
      );
    }

    // Limit results
    const limitedResources = filteredResources.slice(0, limit);

    // Calculate statistics
    const stats = {
      total_found: limitedResources.length,
      by_type: {},
      by_availability: {
        available: limitedResources.filter(r => r.is_available).length,
        unavailable: limitedResources.filter(r => !r.is_available).length
      },
      distance_stats: {
        closest_km: limitedResources.length > 0 ? 
          Math.min(...limitedResources.map(r => r.distance_meters / 1000)) : null,
        furthest_km: limitedResources.length > 0 ? 
          Math.max(...limitedResources.map(r => r.distance_meters / 1000)) : null,
        average_km: limitedResources.length > 0 ? 
          limitedResources.reduce((sum, r) => sum + r.distance_meters, 0) / limitedResources.length / 1000 : null
      }
    };

    // Count by type
    limitedResources.forEach(resource => {
      stats.by_type[resource.type] = (stats.by_type[resource.type] || 0) + 1;
    });

    // Reverse geocode search location for context
    let locationContext = null;
    try {
      const reverseResult = await geocodingService.reverseGeocode(lat, lng);
      if (reverseResult.success) {
        locationContext = {
          location_name: reverseResult.locationName,
          formatted_address: reverseResult.formattedAddress
        };
      }
    } catch (geocodeError) {
      logger.warn('Reverse geocoding failed for resource search', {
        coordinates: [lat, lng],
        error: geocodeError.message
      });
    }

    res.json({
      success: true,
      data: {
        search_location: {
          coordinates: [lat, lng],
          ...locationContext
        },
        resources: limitedResources,
        statistics: stats,
        search_parameters: {
          center: [lat, lng],
          radius_km: distance_km,
          resource_types: resource_types || 'all',
          disaster_id,
          include_unavailable,
          limit
        },
        metadata: {
          searched_at: new Date().toISOString(),
          geocoding_provider: geocodingService.getServiceInfo().provider
        }
      }
    });

  } catch (error) {
    logger.error('Resource search failed', {
      coordinates: [lat, lng],
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to search resources', 500);
  }
}));

/**
 * POST /resources - Create new resource
 */
router.post('/', requirePermission('create'), catchAsync(async (req, res) => {
  // Validate request body
  const { error, value } = resourceSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  const resourceData = {
    ...value,
    created_by: req.user.id
  };

  logger.info('Creating new resource', {
    userId: req.user.id,
    name: resourceData.name,
    type: resourceData.type,
    location: resourceData.location_name
  });

  try {
    // Geocode the location
    const geocodeResult = await geocodingService.geocode(resourceData.location_name);
    
    if (geocodeResult.success && geocodeResult.results.length > 0) {
      const primaryLocation = geocodeResult.results[0];
      
      // Convert to PostGIS geography format
      resourceData.location = `POINT(${primaryLocation.lng} ${primaryLocation.lat})`;
      
      logger.info('Geocoded resource location', {
        locationName: resourceData.location_name,
        coordinates: [primaryLocation.lng, primaryLocation.lat],
        confidence: primaryLocation.confidence
      });
    } else {
      logger.warn('Geocoding failed for resource', {
        locationName: resourceData.location_name,
        geocodeResult
      });
      // Continue without coordinates - user can update later
    }

    // Insert resource into database
    const { data: resource, error: dbError } = await supabase
      .from('resources')
      .insert([resourceData])
      .select('*')
      .single();

    if (dbError) {
      logger.error('Resource creation failed', { error: dbError });
      throw new APIError('Failed to create resource', 500);
    }

    // Emit real-time update
    req.io.emit('resource_created', {
      resource,
      user: req.user.username
    });

    // If associated with a disaster, emit to disaster room
    if (resource.disaster_id) {
      req.io.to(`disaster_${resource.disaster_id}`).emit('resources_updated', {
        disasterId: resource.disaster_id,
        action: 'created',
        resource: {
          id: resource.id,
          name: resource.name,
          type: resource.type
        }
      });
    }

    logger.logResourceAction('created', resource.id, resource.location_name, {
      type: resource.type,
      disasterId: resource.disaster_id,
      geocoded: !!resourceData.location
    });

    res.status(201).json({
      success: true,
      data: {
        resource,
        geocode_result: geocodeResult.success ? {
          provider: geocodeResult.provider,
          confidence: geocodeResult.results[0]?.confidence
        } : null
      }
    });

  } catch (error) {
    logger.error('Resource creation failed', {
      error: error.message,
      userId: req.user.id,
      resourceData: { name: resourceData.name, type: resourceData.type }
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to create resource', 500);
  }
}));

/**
 * GET /resources - List resources with filtering
 */
router.get('/', requirePermission('read'), catchAsync(async (req, res) => {
  const {
    disaster_id,
    type,
    is_available,
    created_by,
    location,
    radius = 50000, // 50km default
    page = 1,
    limit = 20,
    sort_by = 'created_at',
    sort_order = 'desc'
  } = req.query;

  logger.info('Fetching resources', {
    userId: req.user.id,
    filters: { disaster_id, type, is_available, created_by, location },
    pagination: { page, limit }
  });

  try {
    let query = supabase
      .from('resources')
      .select('*');

    // Apply filters
    if (disaster_id) {
      query = query.eq('disaster_id', disaster_id);
    }

    if (type) {
      query = query.eq('type', type);
    }

    if (is_available !== undefined) {
      query = query.eq('is_available', is_available === 'true');
    }

    if (created_by) {
      query = query.eq('created_by', created_by);
    }

    // Geospatial filtering
    if (location) {
      const [lat, lng] = location.split(',').map(parseFloat);
      if (!isNaN(lat) && !isNaN(lng)) {
        // Use PostGIS for geographic distance
        const { data: nearbyResources, error: geoError } = await supabase
          .rpc('find_nearby_resources', {
            disaster_lat: lat,
            disaster_lng: lng,
            distance_meters: parseInt(radius),
            resource_types: type ? [type] : null
          });

        if (geoError) {
          throw new APIError('Geospatial query failed', 500);
        }

        // Apply other filters to nearby results
        let filteredResources = nearbyResources;
        
        if (disaster_id) {
          filteredResources = filteredResources.filter(r => r.disaster_id === disaster_id);
        }
        
        if (is_available !== undefined) {
          filteredResources = filteredResources.filter(r => r.is_available === (is_available === 'true'));
        }
        
        if (created_by) {
          filteredResources = filteredResources.filter(r => r.created_by === created_by);
        }

        // Apply pagination
        const offset = (parseInt(page) - 1) * parseInt(limit);
        const paginatedResources = filteredResources.slice(offset, offset + parseInt(limit));

        return res.json({
          success: true,
          data: paginatedResources,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: filteredResources.length,
            totalPages: Math.ceil(filteredResources.length / parseInt(limit))
          },
          filters: { disaster_id, type, is_available, created_by, location, radius }
        });
      }
    }

    // Sorting
    const validSortFields = ['created_at', 'updated_at', 'name', 'type'];
    const sortField = validSortFields.includes(sort_by) ? sort_by : 'created_at';
    const sortDirection = sort_order.toLowerCase() === 'asc' ? true : false;
    
    query = query.order(sortField, { ascending: sortDirection });

    // Pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    query = query.range(offset, offset + parseInt(limit) - 1);

    const { data: resources, error, count } = await query;

    if (error) {
      logger.error('Resource fetch failed', { error: error.message });
      throw new APIError('Failed to fetch resources', 500);
    }

    // Calculate pagination metadata
    const totalPages = Math.ceil(count / parseInt(limit));

    res.json({
      success: true,
      data: resources,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages,
        hasNextPage: parseInt(page) < totalPages,
        hasPrevPage: parseInt(page) > 1
      },
      filters: { disaster_id, type, is_available, created_by, location, radius }
    });

  } catch (error) {
    logger.error('Resource list fetch failed', {
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to fetch resources', 500);
  }
}));

/**
 * GET /resources/:id - Get specific resource
 */
router.get('/:id', requirePermission('read'), catchAsync(async (req, res) => {
  const { id } = req.params;

  try {
    const { data: resource, error } = await supabase
      .from('resources')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new APIError('Resource not found', 404);
      }
      throw new APIError('Failed to fetch resource', 500);
    }

    res.json({
      success: true,
      data: resource
    });

  } catch (error) {
    logger.error('Resource fetch failed', {
      resourceId: id,
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to fetch resource', 500);
  }
}));

/**
 * PUT /resources/:id - Update resource
 */
router.put('/:id', requirePermission('update'), catchAsync(async (req, res) => {
  const { id } = req.params;
  
  const updateSchema = resourceSchema.fork(
    ['name', 'location_name', 'type'], 
    (schema) => schema.optional()
  );

  const { error, value } = updateSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  try {
    // Check if resource exists and user has permission
    const { data: existingResource, error: fetchError } = await supabase
      .from('resources')
      .select('created_by, disaster_id')
      .eq('id', id)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        throw new APIError('Resource not found', 404);
      }
      throw new APIError('Failed to fetch resource', 500);
    }

    // Check ownership or admin privileges
    if (req.user.role !== 'admin' && existingResource.created_by !== req.user.id) {
      throw new APIError('Insufficient permissions to update this resource', 403);
    }

    const updateData = { ...value };

    // If location_name changed, re-geocode
    if (value.location_name) {
      try {
        const geocodeResult = await geocodingService.geocode(value.location_name);
        
        if (geocodeResult.success && geocodeResult.results.length > 0) {
          const primaryLocation = geocodeResult.results[0];
          updateData.location = `POINT(${primaryLocation.lng} ${primaryLocation.lat})`;
          
          logger.info('Re-geocoded resource location', {
            resourceId: id,
            newLocation: value.location_name,
            coordinates: [primaryLocation.lng, primaryLocation.lat]
          });
        }
      } catch (geocodeError) {
        logger.warn('Re-geocoding failed during resource update', {
          resourceId: id,
          error: geocodeError.message
        });
      }
    }

    // Update resource
    const { data: updatedResource, error: updateError } = await supabase
      .from('resources')
      .update(updateData)
      .eq('id', id)
      .select('*')
      .single();

    if (updateError) {
      logger.error('Resource update failed', { 
        resourceId: id, 
        error: updateError.message 
      });
      throw new APIError('Failed to update resource', 500);
    }

    // Emit real-time update
    req.io.emit('resource_updated', {
      resource: updatedResource,
      updatedBy: req.user.username,
      changes: Object.keys(value)
    });

    // If associated with a disaster, emit to disaster room
    if (updatedResource.disaster_id) {
      req.io.to(`disaster_${updatedResource.disaster_id}`).emit('resources_updated', {
        disasterId: updatedResource.disaster_id,
        action: 'updated',
        resource: {
          id: updatedResource.id,
          name: updatedResource.name,
          type: updatedResource.type
        }
      });
    }

    logger.logResourceAction('updated', id, updatedResource.location_name, {
      fieldsUpdated: Object.keys(value)
    });

    res.json({
      success: true,
      data: updatedResource
    });

  } catch (error) {
    logger.error('Resource update failed', {
      resourceId: id,
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to update resource', 500);
  }
}));

/**
 * DELETE /resources/:id - Delete resource
 */
router.delete('/:id', requirePermission('delete'), catchAsync(async (req, res) => {
  const { id } = req.params;

  try {
    // Check if resource exists and user has permission
    const { data: existingResource, error: fetchError } = await supabase
      .from('resources')
      .select('created_by, name, type, disaster_id')
      .eq('id', id)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        throw new APIError('Resource not found', 404);
      }
      throw new APIError('Failed to fetch resource', 500);
    }

    // Check ownership or admin privileges
    if (req.user.role !== 'admin' && existingResource.created_by !== req.user.id) {
      throw new APIError('Insufficient permissions to delete this resource', 403);
    }

    // Delete resource
    const { error: deleteError } = await supabase
      .from('resources')
      .delete()
      .eq('id', id);

    if (deleteError) {
      logger.error('Resource deletion failed', { 
        resourceId: id, 
        error: deleteError.message 
      });
      throw new APIError('Failed to delete resource', 500);
    }

    // Emit real-time update
    req.io.emit('resource_deleted', {
      resourceId: id,
      name: existingResource.name,
      type: existingResource.type,
      deletedBy: req.user.username
    });

    // If associated with a disaster, emit to disaster room
    if (existingResource.disaster_id) {
      req.io.to(`disaster_${existingResource.disaster_id}`).emit('resources_updated', {
        disasterId: existingResource.disaster_id,
        action: 'deleted',
        resource: {
          id: id,
          name: existingResource.name,
          type: existingResource.type
        }
      });
    }

    logger.logResourceAction('deleted', id, null, {
      name: existingResource.name,
      type: existingResource.type
    });

    res.json({
      success: true,
      message: 'Resource deleted successfully'
    });

  } catch (error) {
    logger.error('Resource deletion failed', {
      resourceId: id,
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to delete resource', 500);
  }
}));

module.exports = router;