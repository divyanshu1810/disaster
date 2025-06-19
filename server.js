const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Import utilities and routes
const logger = require('./utils/logger');
const { authenticateUser } = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');

// Import route handlers
const disasterRoutes = require('./routes/disasters');
const geocodingRoutes = require('./routes/geocoding');
const socialMediaRoutes = require('./routes/socialMedia');
const resourceRoutes = require('./routes/resources');
const verificationRoutes = require('./routes/verification');
const officialUpdatesRoutes = require('./routes/officialUpdates');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? process.env.FRONTEND_URL 
      : "http://localhost:5500",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 5000;

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: {
    error: 'Too many requests from this IP, please try again later'
  }
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(limiter);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    timestamp: new Date().toISOString()
  });
  next();
});

// Make io accessible to routes
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// API Routes
app.use('/api/disasters', authenticateUser, disasterRoutes);
app.use('/api/geocoding', authenticateUser, geocodingRoutes);
app.use('/api/social-media', authenticateUser, socialMediaRoutes);
app.use('/api/resources', authenticateUser, resourceRoutes);
app.use('/api/verification', authenticateUser, verificationRoutes);
app.use('/api/official-updates', authenticateUser, officialUpdatesRoutes);

// Error handling
app.use(errorHandler.errorHandler);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found'
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info('User connected', { socketId: socket.id });

  socket.on('join_disaster', (disasterId) => {
    socket.join(`disaster_${disasterId}`);
    logger.info('User joined disaster room', { 
      socketId: socket.id, 
      disasterId 
    });
  });

  socket.on('leave_disaster', (disasterId) => {
    socket.leave(`disaster_${disasterId}`);
    logger.info('User left disaster room', { 
      socketId: socket.id, 
      disasterId 
    });
  });

  socket.on('disconnect', () => {
    logger.info('User disconnected', { socketId: socket.id });
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    logger.info('Process terminated');
    process.exit(0);
  });
});

server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`, {
    environment: process.env.NODE_ENV,
    port: PORT
  });
});

module.exports = { app, io };