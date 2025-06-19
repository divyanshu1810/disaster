const logger = require('../utils/logger');

// Mock users as specified in requirements
const MOCK_USERS = {
  'netrunnerX': {
    id: 'netrunnerX',
    username: 'netrunnerX',
    role: 'admin',
    permissions: ['create', 'read', 'update', 'delete', 'verify']
  },
  'reliefAdmin': {
    id: 'reliefAdmin',
    username: 'reliefAdmin',
    role: 'admin',
    permissions: ['create', 'read', 'update', 'delete', 'verify']
  },
  'contributor1': {
    id: 'contributor1',
    username: 'contributor1',
    role: 'contributor',
    permissions: ['create', 'read', 'update']
  },
  'citizen1': {
    id: 'citizen1',
    username: 'citizen1',
    role: 'contributor',
    permissions: ['create', 'read']
  }
};

/**
 * Mock authentication middleware
 * Expects 'x-user-id' header with user identifier
 */
const authenticateUser = (req, res, next) => {
  const userId = req.headers['x-user-id'];

  if (!userId) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please provide x-user-id header'
    });
  }

  const user = MOCK_USERS[userId];
  if (!user) {
    logger.warn('Authentication failed - invalid user', { userId });
    return res.status(401).json({
      error: 'Invalid user',
      message: 'User not found in system'
    });
  }

  // Attach user info to request
  req.user = user;
  
  logger.info('User authenticated', {
    userId: user.id,
    role: user.role,
    endpoint: req.path
  });

  next();
};

/**
 * Authorization middleware factory
 * @param {string|string[]} requiredPermissions - Permission(s) required
 */
const requirePermission = (requiredPermissions) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required'
      });
    }

    const permissions = Array.isArray(requiredPermissions) 
      ? requiredPermissions 
      : [requiredPermissions];

    const hasPermission = permissions.some(permission => 
      req.user.permissions.includes(permission)
    );

    if (!hasPermission) {
      logger.warn('Authorization failed', {
        userId: req.user.id,
        requiredPermissions,
        userPermissions: req.user.permissions
      });
      
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: permissions,
        current: req.user.permissions
      });
    }

    next();
  };
};

/**
 * Check if user owns resource or has admin privileges
 */
const requireOwnershipOrAdmin = (req, res, next) => {
  const resourceOwnerId = req.body.owner_id || req.params.owner_id;
  
  if (req.user.role === 'admin' || req.user.id === resourceOwnerId) {
    return next();
  }

  logger.warn('Ownership check failed', {
    userId: req.user.id,
    resourceOwnerId,
    userRole: req.user.role
  });

  return res.status(403).json({
    error: 'Access denied',
    message: 'You can only modify your own resources'
  });
};

module.exports = {
  authenticateUser,
  requirePermission,
  requireOwnershipOrAdmin,
  MOCK_USERS
};