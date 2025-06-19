const express = require('express');
const Joi = require('joi');
const { supabase } = require('../config/supabase');
const { requirePermission } = require('../middleware/auth');
const { catchAsync, APIError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const geminiService = require('../services/gemini');

const router = express.Router();

// Validation schemas
const verifyImageSchema = Joi.object({
  image_url: Joi.string().uri().required(),
  context: Joi.string().max(1000).optional(),
  disaster_id: Joi.string().uuid().optional(),
  report_id: Joi.string().uuid().optional()
});

const updateVerificationSchema = Joi.object({
  verification_status: Joi.string().valid('verified', 'rejected', 'flagged').required(),
  verification_notes: Joi.string().max(1000).optional(),
  manual_override: Joi.boolean().default(false)
});

/**
 * POST /verification/verify-image - Verify image authenticity
 */
router.post('/verify-image', requirePermission('verify'), catchAsync(async (req, res) => {
  // Validate request body
  const { error, value } = verifyImageSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  const { image_url, context, disaster_id, report_id } = value;

  logger.info('Starting image verification', {
    imageUrl: image_url,
    hasContext: !!context,
    disasterId: disaster_id,
    reportId: report_id,
    userId: req.user.id
  });

  try {
    // If report_id provided, get additional context from the report
    let fullContext = context || '';
    let reportData = null;
    
    if (report_id) {
      const { data: report, error: reportError } = await supabase
        .from('reports')
        .select(`
          *,
          disaster:disasters(title, location_name, description, tags)
        `)
        .eq('id', report_id)
        .single();

      if (reportError) {
        logger.warn('Failed to fetch report for verification context', {
          reportId: report_id,
          error: reportError.message
        });
      } else {
        reportData = report;
        fullContext = `${context || ''} Report: ${report.content}. Disaster: ${report.disaster?.title} in ${report.disaster?.location_name}. Tags: ${report.disaster?.tags?.join(', ')}`.trim();
      }
    } else if (disaster_id) {
      // Get disaster context
      const { data: disaster, error: disasterError } = await supabase
        .from('disasters')
        .select('title, location_name, description, tags')
        .eq('id', disaster_id)
        .single();

      if (!disasterError && disaster) {
        fullContext = `${context || ''} Disaster: ${disaster.title} in ${disaster.location_name}. ${disaster.description}. Tags: ${disaster.tags?.join(', ')}`.trim();
      }
    }

    // Perform AI verification using Gemini
    const verificationResult = await geminiService.verifyImage(image_url, fullContext);

    // Store verification result in database if associated with a report
    let storedVerification = null;
    if (report_id) {
      try {
        // Update the report with verification results
        const { data: updatedReport, error: updateError } = await supabase
          .from('reports')
          .update({
            verification_status: verificationResult.isAuthentic ? 'verified' : 'rejected',
            verification_notes: verificationResult.reasoning,
            verified_by: req.user.id,
            verified_at: new Date().toISOString()
          })
          .eq('id', report_id)
          .select('*')
          .single();

        if (updateError) {
          logger.warn('Failed to update report verification status', {
            reportId: report_id,
            error: updateError.message
          });
        } else {
          storedVerification = updatedReport;
          
          // Emit real-time update for report verification
          req.io.emit('report_verified', {
            reportId: report_id,
            verificationStatus: updatedReport.verification_status,
            verifiedBy: req.user.username,
            isAuthentic: verificationResult.isAuthentic,
            confidence: verificationResult.confidence
          });

          // If associated with disaster, emit to disaster room
          if (updatedReport.disaster_id) {
            req.io.to(`disaster_${updatedReport.disaster_id}`).emit('verification_completed', {
              disasterId: updatedReport.disaster_id,
              reportId: report_id,
              verificationStatus: updatedReport.verification_status,
              imageUrl: image_url
            });
          }
        }
      } catch (updateErr) {
        logger.error('Failed to store verification result', {
          reportId: report_id,
          error: updateErr.message
        });
      }
    }

    // Log verification action
    logger.info('Image verification completed', {
      imageUrl: image_url,
      isAuthentic: verificationResult.isAuthentic,
      confidence: verificationResult.confidence,
      reportId: report_id,
      disasterId: disaster_id,
      userId: req.user.id,
      verifiedBy: req.user.username
    });

    res.json({
      success: true,
      data: {
        verification: verificationResult,
        input: {
          image_url,
          context: fullContext,
          disaster_id,
          report_id
        },
        stored_verification: storedVerification,
        metadata: {
          verified_by: req.user.username,
          verified_at: new Date().toISOString(),
          ai_provider: 'google_gemini'
        }
      }
    });

  } catch (error) {
    logger.error('Image verification failed', {
      imageUrl: image_url,
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Image verification failed', 500);
  }
}));

/**
 * GET /verification/reports/:id/status - Get verification status of a report
 */
router.get('/reports/:id/status', requirePermission('read'), catchAsync(async (req, res) => {
  const { id: reportId } = req.params;

  try {
    const { data: report, error } = await supabase
      .from('reports')
      .select(`
        id,
        verification_status,
        verification_notes,
        verified_by,
        verified_at,
        image_url,
        content,
        disaster:disasters(id, title, location_name)
      `)
      .eq('id', reportId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new APIError('Report not found', 404);
      }
      throw new APIError('Failed to fetch report verification status', 500);
    }

    // Get verifier information if available
    let verifierInfo = null;
    if (report.verified_by) {
      // In a real system, you'd fetch user details from a users table
      // For now, we'll use mock user data
      const { MOCK_USERS } = require('../middleware/auth');
      verifierInfo = MOCK_USERS[report.verified_by] ? {
        id: report.verified_by,
        username: MOCK_USERS[report.verified_by].username,
        role: MOCK_USERS[report.verified_by].role
      } : {
        id: report.verified_by,
        username: report.verified_by,
        role: 'unknown'
      };
    }

    res.json({
      success: true,
      data: {
        report: {
          id: report.id,
          content: report.content,
          image_url: report.image_url,
          disaster: report.disaster
        },
        verification: {
          status: report.verification_status,
          notes: report.verification_notes,
          verified_by: verifierInfo,
          verified_at: report.verified_at,
          has_image: !!report.image_url,
          can_reverify: req.user.permissions.includes('verify')
        },
        metadata: {
          fetched_at: new Date().toISOString(),
          fetched_by: req.user.username
        }
      }
    });

  } catch (error) {
    logger.error('Verification status fetch failed', {
      reportId,
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to fetch verification status', 500);
  }
}));

/**
 * PUT /verification/reports/:id/status - Update verification status manually
 */
router.put('/reports/:id/status', requirePermission('verify'), catchAsync(async (req, res) => {
  const { id: reportId } = req.params;
  
  // Validate request body
  const { error, value } = updateVerificationSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  const { verification_status, verification_notes, manual_override } = value;

  logger.info('Manually updating verification status', {
    reportId,
    newStatus: verification_status,
    manualOverride: manual_override,
    userId: req.user.id
  });

  try {
    // Check if report exists
    const { data: existingReport, error: fetchError } = await supabase
      .from('reports')
      .select('id, verification_status, verified_by, disaster_id, image_url')
      .eq('id', reportId)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        throw new APIError('Report not found', 404);
      }
      throw new APIError('Failed to fetch report', 500);
    }

    // Check if already verified by someone else (unless admin or manual override)
    if (existingReport.verified_by && 
        existingReport.verified_by !== req.user.id && 
        req.user.role !== 'admin' && 
        !manual_override) {
      throw new APIError('Report already verified by another user. Use manual_override flag to override.', 409);
    }

    // Update verification status
    const updateData = {
      verification_status,
      verification_notes,
      verified_by: req.user.id,
      verified_at: new Date().toISOString()
    };

    const { data: updatedReport, error: updateError } = await supabase
      .from('reports')
      .update(updateData)
      .eq('id', reportId)
      .select(`
        *,
        disaster:disasters(id, title, location_name)
      `)
      .single();

    if (updateError) {
      logger.error('Verification status update failed', {
        reportId,
        error: updateError.message
      });
      throw new APIError('Failed to update verification status', 500);
    }

    // Emit real-time updates
    req.io.emit('report_verified', {
      reportId,
      verificationStatus: verification_status,
      verifiedBy: req.user.username,
      isManualOverride: manual_override,
      hasImage: !!existingReport.image_url
    });

    // If associated with disaster, emit to disaster room
    if (updatedReport.disaster_id) {
      req.io.to(`disaster_${updatedReport.disaster_id}`).emit('verification_completed', {
        disasterId: updatedReport.disaster_id,
        reportId,
        verificationStatus: verification_status,
        verifiedBy: req.user.username
      });
    }

    logger.info('Verification status updated successfully', {
      reportId,
      oldStatus: existingReport.verification_status,
      newStatus: verification_status,
      verifiedBy: req.user.username,
      manualOverride: manual_override
    });

    res.json({
      success: true,
      data: {
        report: updatedReport,
        verification_update: {
          previous_status: existingReport.verification_status,
          new_status: verification_status,
          verified_by: req.user.username,
          verified_at: updateData.verified_at,
          manual_override: manual_override
        },
        metadata: {
          updated_at: new Date().toISOString()
        }
      }
    });

  } catch (error) {
    logger.error('Verification status update failed', {
      reportId,
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to update verification status', 500);
  }
}));

/**
 * GET /verification/stats - Get verification statistics
 */
router.get('/stats', requirePermission('read'), catchAsync(async (req, res) => {
  const {
    disaster_id,
    time_window = 168, // 1 week default
    verified_by
  } = req.query;

  logger.info('Fetching verification statistics', {
    disasterId: disaster_id,
    timeWindow: time_window,
    verifiedBy: verified_by,
    userId: req.user.id
  });

  try {
    const cutoffTime = new Date(Date.now() - time_window * 60 * 60 * 1000).toISOString();

    // Build query for reports
    let query = supabase
      .from('reports')
      .select('verification_status, verified_by, verified_at, image_url, disaster_id')
      .gte('created_at', cutoffTime);

    if (disaster_id) {
      query = query.eq('disaster_id', disaster_id);
    }

    if (verified_by) {
      query = query.eq('verified_by', verified_by);
    }

    const { data: reports, error } = await query;

    if (error) {
      throw new APIError('Failed to fetch verification statistics', 500);
    }

    // Calculate statistics
    const stats = {
      total_reports: reports.length,
      reports_with_images: reports.filter(r => r.image_url).length,
      by_status: {
        pending: reports.filter(r => r.verification_status === 'pending').length,
        verified: reports.filter(r => r.verification_status === 'verified').length,
        rejected: reports.filter(r => r.verification_status === 'rejected').length,
        flagged: reports.filter(r => r.verification_status === 'flagged').length
      },
      verification_rate: {
        total_verified: reports.filter(r => r.verification_status !== 'pending').length,
        percentage: reports.length > 0 ? 
          ((reports.filter(r => r.verification_status !== 'pending').length / reports.length) * 100).toFixed(1) + '%' : '0%'
      },
      by_verifier: {},
      by_disaster: {}
    };

    // Count by verifier
    reports.forEach(report => {
      if (report.verified_by) {
        const verifier = report.verified_by;
        if (!stats.by_verifier[verifier]) {
          stats.by_verifier[verifier] = {
            total: 0,
            verified: 0,
            rejected: 0,
            flagged: 0
          };
        }
        stats.by_verifier[verifier].total++;
        if (report.verification_status !== 'pending') {
          stats.by_verifier[verifier][report.verification_status]++;
        }
      }
    });

    // Count by disaster
    reports.forEach(report => {
      if (report.disaster_id) {
        const disasterId = report.disaster_id;
        if (!stats.by_disaster[disasterId]) {
          stats.by_disaster[disasterId] = {
            total: 0,
            verified: 0,
            rejected: 0,
            flagged: 0,
            pending: 0
          };
        }
        stats.by_disaster[disasterId].total++;
        stats.by_disaster[disasterId][report.verification_status || 'pending']++;
      }
    });

    // Get top verifiers
    const topVerifiers = Object.entries(stats.by_verifier)
      .sort(([,a], [,b]) => b.total - a.total)
      .slice(0, 5)
      .map(([verifierId, verifierStats]) => ({
        verifier_id: verifierId,
        ...verifierStats
      }));

    res.json({
      success: true,
      data: {
        overview: stats,
        top_verifiers: topVerifiers,
        analysis_period: {
          hours: parseInt(time_window),
          from: cutoffTime,
          to: new Date().toISOString()
        },
        filters: {
          disaster_id: disaster_id || null,
          verified_by: verified_by || null
        },
        metadata: {
          generated_at: new Date().toISOString(),
          generated_by: req.user.username
        }
      }
    });

  } catch (error) {
    logger.error('Verification statistics fetch failed', {
      error: error.message,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Failed to fetch verification statistics', 500);
  }
}));

/**
 * POST /verification/batch-verify - Batch verify multiple images
 */
router.post('/batch-verify', requirePermission('verify'), catchAsync(async (req, res) => {
  const batchSchema = Joi.object({
    verifications: Joi.array().items(
      Joi.object({
        image_url: Joi.string().uri().required(),
        context: Joi.string().max(1000).optional(),
        report_id: Joi.string().uuid().optional()
      })
    ).min(1).max(5).required() // Limit to 5 images per batch
  });

  const { error, value } = batchSchema.validate(req.body);
  if (error) {
    throw new APIError(`Validation error: ${error.details[0].message}`, 400);
  }

  const { verifications } = value;

  logger.info('Starting batch image verification', {
    imageCount: verifications.length,
    userId: req.user.id
  });

  try {
    // Process all verifications in parallel with rate limiting
    const verificationPromises = verifications.map(async (verification, index) => {
      // Add small delay to respect rate limits
      await new Promise(resolve => setTimeout(resolve, index * 500));
      
      try {
        const result = await geminiService.verifyImage(
          verification.image_url, 
          verification.context || ''
        );

        // Update report if report_id provided
        let updatedReport = null;
        if (verification.report_id) {
          try {
            const { data: report, error: updateError } = await supabase
              .from('reports')
              .update({
                verification_status: result.isAuthentic ? 'verified' : 'rejected',
                verification_notes: result.reasoning,
                verified_by: req.user.id,
                verified_at: new Date().toISOString()
              })
              .eq('id', verification.report_id)
              .select('*')
              .single();

            if (!updateError) {
              updatedReport = report;
            }
          } catch (updateErr) {
            logger.warn('Failed to update report in batch verification', {
              reportId: verification.report_id,
              error: updateErr.message
            });
          }
        }

        return {
          image_url: verification.image_url,
          report_id: verification.report_id,
          success: true,
          verification: result,
          updated_report: updatedReport
        };
      } catch (error) {
        return {
          image_url: verification.image_url,
          report_id: verification.report_id,
          success: false,
          error: error.message,
          verification: null,
          updated_report: null
        };
      }
    });

    const results = await Promise.all(verificationPromises);

    // Calculate statistics
    const successCount = results.filter(r => r.success).length;
    const authenticCount = results.filter(r => r.success && r.verification.isAuthentic).length;
    const updatedReports = results.filter(r => r.updated_report).length;

    // Emit real-time updates for successful verifications
    results.forEach(result => {
      if (result.success && result.updated_report) {
        req.io.emit('report_verified', {
          reportId: result.report_id,
          verificationStatus: result.updated_report.verification_status,
          verifiedBy: req.user.username,
          isAuthentic: result.verification.isAuthentic,
          confidence: result.verification.confidence
        });
      }
    });

    logger.info('Batch verification completed', {
      totalImages: verifications.length,
      successfulVerifications: successCount,
      authenticImages: authenticCount,
      updatedReports,
      userId: req.user.id
    });

    res.json({
      success: true,
      data: {
        results,
        summary: {
          total_images: verifications.length,
          successful_verifications: successCount,
          failed_verifications: verifications.length - successCount,
          authentic_images: authenticCount,
          rejected_images: successCount - authenticCount,
          updated_reports: updatedReports,
          success_rate: `${(successCount / verifications.length * 100).toFixed(1)}%`
        },
        metadata: {
          verified_by: req.user.username,
          verified_at: new Date().toISOString(),
          ai_provider: 'google_gemini'
        }
      }
    });

  } catch (error) {
    logger.error('Batch verification failed', {
      error: error.message,
      imageCount: verifications.length,
      userId: req.user.id
    });
    
    if (error instanceof APIError) {
      throw error;
    }
    throw new APIError('Batch verification failed', 500);
  }
}));

module.exports = router;