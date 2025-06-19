const express = require('express');
const Joi = require('joi');
const { supabase } = require('../config/supabase');
const { requirePermission, requireOwnershipOrAdmin } = require('../middleware/auth');
const { catchAsync, APIError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const geocodingService = require('../services/geocoding');
const geminiService = require('../services/gemini');

const router = express.Router();

// Validation schemas
const disasterSchema = Joi.object({
  title: Joi.string().min(3).max(255).required(),
  location_name: Joi.string().min(2).max(500).required(),
  description: Joi.string().min(10).max(5000).required(),
  tags: Joi.array().items(
    Joi.string().valid(
      'flood', 'earthquake', 'fire', 'hurricane', 'tornado', 
      'landslide', 'tsunami', 'volcanic', 'drought', 'blizzard', 
      'heatwave', 'other'
    )
  ).min(1).required(),
  priority_level: Joi.number().integer().min(1).max(5).default(1),
  affected_population: Joi.number().integer().min(0).optional(),
  estimated_damage: Joi.number().min(0).optional()
});

const updateDisasterSchema = disasterSchema.fork(
  ['title', 'location_name', 'description', 'tags'], 
  (schema) => schema.optional()
);

/**
 * POST /disasters - Create new disaster
 */
router.post('/', requirePermission('create'), catchAsync(async (req, res) => {
  // Validate request body
  const { error, value } = disasterSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  const disasterData = {
    ...value,
    owner_id: req.user.id
  };

  logger.info('Creating new disaster', {
    userId: req.user.id,
    title: disasterData.title,
    location: disasterData.location_name
  });

  try {
    // Extract additional locations from description using Gemini
    const extractedLocations = await geminiService.extractLocations(disasterData.description);
    
    // Geocode the primary location
    const geocodeResult = await geocodingService.geocode(disasterData.location_name);
    
    if (geocodeResult.success && geocodeResult.results.length > 0) {
      const primaryLocation = geocodeResult.results[0];
      
      // Convert to PostGIS geography format
      disasterData.location = `POINT(${primaryLocation.lng} ${primaryLocation.lat})`;
      
      logger.info('Geocoded disaster location', {
        locationName: disasterData.location_name,
        coordinates: [primaryLocation.lng, primaryLocation.lat],
        confidence: primaryLocation.confidence
      });
    } else {
      logger.warn('Geocoding failed, storing without coordinates', {
        locationName: disasterData.location_name,
        geocodeResult
      });
    }

    // Insert disaster into database
    const { data: disaster, error: dbError } = await supabase
      .from('disasters')
      .insert([disasterData])
      .select('*')
      .single();

    if (dbError) {
      logger.error('Database insert failed', { error: dbError });
      throw new APIError('Failed to create disaster', 500);
    }

    // Add audit trail entry
    await supabase.rpc('add_audit_trail', {
      table_name: 'disasters',
      record_id: disaster.id,
      action: 'create',
      user_id: req.user.id,
      details: { extractedLocations }
    });

    // Emit real-time update
    req.io.emit('disaster_created', {
      disaster,
      extractedLocations,
      user: req.user.username
    });

    logger.logDisasterAction('created', disaster.id, req.user.id, {
      extractedLocations: extractedLocations.length,
      geocoded: !!disasterData.location
    });

    res.status(201).json({
      success: true,
      data: {
        disaster,
        extractedLocations,
        geocodeResult: geocodeResult.success ? {
          provider: geocodeResult.provider,
          confidence: geocodeResult.results[0]?.confidence
        } : null
      }
    });

  } catch (error) {
    logger.error('Disaster creation failed', {
      error: error.message,
      userId: req.user.id,
      disasterData: { title: disasterData.title, location: disasterData.location_name }
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to create disaster', 500);
  }
}));

/**
 * GET /disasters - List disasters with filtering and pagination
 */
router.get('/', requirePermission('read'), catchAsync(async (req, res) => {
  const {
    tag,
    owner_id,
    is_active = true,
    priority_level,
    location,
    radius = 50000, // 50km default
    page = 1,
    limit = 20,
    sort_by = 'created_at',
    sort_order = 'desc'
  } = req.query;

  logger.info('Fetching disasters', {
    userId: req.user.id,
    filters: { tag, owner_id, is_active, priority_level, location },
    pagination: { page, limit }
  });

  try {
    let query = supabase
      .from('disasters')
      .select(`
        *,
        reports:reports(count),
        resources:resources(count)
      `);

    logger.info('Initial disaster query', {
      filters: { tag, owner_id, is_active, priority_level, location },
      pagination: { page, limit },
      sort: { sort_by, sort_order }
    });

    // Apply filters
    if (tag) {
      query = query.contains('tags', [tag]);
    }

    if (owner_id) {
      query = query.eq('owner_id', owner_id);
    }

    if (priority_level) {
      query = query.eq('priority_level', parseInt(priority_level));
    }

    // Geospatial filtering
    if (location) {
      const [lat, lng] = location.split(',').map(parseFloat);
      if (!isNaN(lat) && !isNaN(lng)) {
        // Use PostGIS ST_DWithin for geographic distance
        query = query.rpc('find_disasters_within_distance', {
          lat: lat,
          lng: lng,
          distance_meters: parseInt(radius)
        });
      }
    }

    logger.info('Applied filters to disaster query', {
      filters: { tag, owner_id, is_active, priority_level, location },
      radius: parseInt(radius)
    });

    // Sorting
    const validSortFields = ['created_at', 'updated_at', 'priority_level', 'title'];
    const sortField = validSortFields.includes(sort_by) ? sort_by : 'created_at';
    const sortDirection = sort_order.toLowerCase() === 'asc' ? true : false;
    
    query = query.order(sortField, { ascending: sortDirection });

    // Pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    query = query.range(offset, offset + parseInt(limit) - 1);

    const { data: disasters, error, count } = await query
      .throwOnError()

    logger.info('Disaster query executed', {
      count,
      page: parseInt(page),
      limit: parseInt(limit),
      disastersCount: disasters ? disasters.length : 0
    });

    if (error) {
      logger.error('Disaster fetch failed', { error: error.message });
      throw new APIError('Failed to fetch disasters', 500);
    }

    // Calculate pagination metadata
    const totalPages = Math.ceil(count / parseInt(limit));
    const hasNextPage = parseInt(page) < totalPages;
    const hasPrevPage = parseInt(page) > 1;

    res.json({
      success: true,
      data: disasters,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        totalPages,
        hasNextPage,
        hasPrevPage
      },
      filters: {
        tag, owner_id, is_active, priority_level, location, radius
      }
    });

  } catch (error) {
    logger.error('Disaster list fetch failed', {
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to fetch disasters', 500);
  }
}));

/**
 * GET /disasters/:id - Get specific disaster
 */
router.get('/:id', requirePermission('read'), catchAsync(async (req, res) => {
  const { id } = req.params;
  const { include_reports = false, include_resources = false } = req.query;

  logger.info('Fetching disaster details', {
    disasterId: id,
    userId: req.user.id,
    includes: { reports: include_reports, resources: include_resources }
  });

  try {
    let selectFields = '*';
    
    if (include_reports === 'true' || include_resources === 'true') {
      const includes = [];
      if (include_reports === 'true') includes.push('reports(*)');
      if (include_resources === 'true') includes.push('resources(*)');
      selectFields = `*, ${includes.join(', ')}`;
    }

    const { data: disaster, error } = await supabase
      .from('disasters')
      .select(selectFields)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') { // No rows returned
        throw new APIError('Disaster not found', 404);
      }
      throw new APIError('Failed to fetch disaster', 500);
    }

    logger.logDisasterAction('viewed', id, req.user.id);

    res.json({
      success: true,
      data: disaster
    });

  } catch (error) {
    logger.error('Disaster fetch failed', {
      disasterId: id,
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to fetch disaster', 500);
  }
}));

/**
 * PUT /disasters/:id - Update disaster
 */
router.put('/:id', requirePermission('update'), catchAsync(async (req, res) => {
  const { id } = req.params;

  // Validate request body
  const { error, value } = updateDisasterSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  logger.info('Updating disaster', {
    disasterId: id,
    userId: req.user.id,
    updates: Object.keys(value)
  });

  try {
    // First, get the existing disaster to check ownership
    const { data: existingDisaster, error: fetchError } = await supabase
      .from('disasters')
      .select('owner_id')
      .eq('id', id)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        throw new APIError('Disaster not found', 404);
      }
      throw new APIError('Failed to fetch disaster', 500);
    }

    // Check ownership or admin privileges
    if (req.user.role !== 'admin' && existingDisaster.owner_id !== req.user.id) {
      throw new APIError('Insufficient permissions to update this disaster', 403);
    }

    const updateData = { ...value };

    // If location_name changed, re-geocode
    if (value.location_name) {
      try {
        const geocodeResult = await geocodingService.geocode(value.location_name);
        
        if (geocodeResult.success && geocodeResult.results.length > 0) {
          const primaryLocation = geocodeResult.results[0];
          updateData.location = `POINT(${primaryLocation.lng} ${primaryLocation.lat})`;
          
          logger.info('Re-geocoded disaster location', {
            disasterId: id,
            newLocation: value.location_name,
            coordinates: [primaryLocation.lng, primaryLocation.lat]
          });
        }
      } catch (geocodeError) {
        logger.warn('Re-geocoding failed during update', {
          disasterId: id,
          error: geocodeError.message
        });
      }
    }

    // Update disaster
    const { data: updatedDisaster, error: updateError } = await supabase
      .from('disasters')
      .update(updateData)
      .eq('id', id)
      .select('*')
      .single();

    if (updateError) {
      logger.error('Disaster update failed', { 
        disasterId: id, 
        error: updateError.message 
      });
      throw new APIError('Failed to update disaster', 500);
    }

    // Emit real-time update
    req.io.emit('disaster_updated', {
      disaster: updatedDisaster,
      updatedBy: req.user.username,
      changes: Object.keys(value)
    });

    logger.logDisasterAction('updated', id, req.user.id, {
      fieldsUpdated: Object.keys(value)
    });

    res.json({
      success: true,
      data: updatedDisaster
    });

  } catch (error) {
    logger.error('Disaster update failed', {
      disasterId: id,
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to update disaster', 500);
  }
}));

/**
 * DELETE /disasters/:id - Delete disaster
 */
router.delete('/:id', requirePermission('delete'), catchAsync(async (req, res) => {
  const { id } = req.params;

  logger.info('Deleting disaster', {
    disasterId: id,
    userId: req.user.id
  });

  try {
    // First, get the existing disaster to check ownership
    const { data: existingDisaster, error: fetchError } = await supabase
      .from('disasters')
      .select('owner_id, title')
      .eq('id', id)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        throw new APIError('Disaster not found', 404);
      }
      throw new APIError('Failed to fetch disaster', 500);
    }

    // Check ownership or admin privileges
    if (req.user.role !== 'admin' && existingDisaster.owner_id !== req.user.id) {
      throw new APIError('Insufficient permissions to delete this disaster', 403);
    }

    // Soft delete (set is_active to false) instead of hard delete to preserve data
    const { error: deleteError } = await supabase
      .from('disasters')
      .update({ 
        is_active: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (deleteError) {
      logger.error('Disaster deletion failed', { 
        disasterId: id, 
        error: deleteError.message 
      });
      throw new APIError('Failed to delete disaster', 500);
    }

    // Emit real-time update
    req.io.emit('disaster_deleted', {
      disasterId: id,
      title: existingDisaster.title,
      deletedBy: req.user.username
    });

    logger.logDisasterAction('deleted', id, req.user.id, {
      title: existingDisaster.title
    });

    res.json({
      success: true,
      message: 'Disaster deleted successfully'
    });

  } catch (error) {
    logger.error('Disaster deletion failed', {
      disasterId: id,
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to delete disaster', 500);
  }
}));

/**
 * GET /disasters/:id/stats - Get disaster statistics
 */
router.get('/:id/stats', requirePermission('read'), catchAsync(async (req, res) => {
  const { id } = req.params;

  try {
    // Get disaster with related data counts
    const { data: disaster, error } = await supabase
      .from('disasters')
      .select(`
        id, title, created_at, priority_level,
        reports:reports(count),
        resources:resources(count),
        social_media_posts:social_media_posts(count),
        official_updates:official_updates(count)
      `)
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new APIError('Disaster not found', 404);
      }
      throw new APIError('Failed to fetch disaster stats', 500);
    }

    // Get additional statistics
    const [reportsStats, resourcesStats] = await Promise.all([
      // Reports by verification status
      supabase
        .from('reports')
        .select('verification_status')
        .eq('disaster_id', id),
      
      // Resources by type
      supabase
        .from('resources')
        .select('type')
        .eq('disaster_id', id)
    ]);

    const stats = {
      disaster: {
        id: disaster.id,
        title: disaster.title,
        created_at: disaster.created_at,
        priority_level: disaster.priority_level
      },
      counts: {
        reports: disaster.reports[0]?.count || 0,
        resources: disaster.resources[0]?.count || 0,
        social_media_posts: disaster.social_media_posts[0]?.count || 0,
        official_updates: disaster.official_updates[0]?.count || 0
      },
      reports_by_status: {},
      resources_by_type: {}
    };

    // Count reports by verification status
    if (reportsStats.data) {
      reportsStats.data.forEach(report => {
        const status = report.verification_status || 'pending';
        stats.reports_by_status[status] = (stats.reports_by_status[status] || 0) + 1;
      });
    }

    // Count resources by type
    if (resourcesStats.data) {
      resourcesStats.data.forEach(resource => {
        const type = resource.type;
        stats.resources_by_type[type] = (stats.resources_by_type[type] || 0) + 1;
      });
    }

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    logger.error('Disaster stats fetch failed', {
      disasterId: id,
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to fetch disaster statistics', 500);
  }
}));

module.exports = router;