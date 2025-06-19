const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'disaster-response-api' },
  transports: [
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error' 
    }),
    new winston.transports.File({ 
      filename: 'logs/combined.log' 
    })
  ]
});

// Add console transport for development
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

// Helper methods for structured logging
logger.logDisasterAction = (action, disasterId, userId, details = {}) => {
  logger.info(`Disaster ${action}`, {
    action,
    disasterId,
    userId,
    ...details,
    category: 'disaster'
  });
};

logger.logResourceAction = (action, resourceId, location, details = {}) => {
  logger.info(`Resource ${action}`, {
    action,
    resourceId,
    location,
    ...details,
    category: 'resource'
  });
};

logger.logAPICall = (service, endpoint, status, duration, details = {}) => {
  logger.info(`External API call`, {
    service,
    endpoint,
    status,
    duration,
    ...details,
    category: 'api_call'
  });
};

logger.logCacheAction = (action, key, hit, details = {}) => {
  logger.info(`Cache ${action}`, {
    action,
    key,
    hit,
    ...details,
    category: 'cache'
  });
};

module.exports = logger;