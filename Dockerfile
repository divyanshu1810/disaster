# Use the official Node.js 18 image as base
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Create logs directory
RUN mkdir -p logs

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S disaster-app -u 1001

# Copy application code
COPY --chown=disaster-app:nodejs . .

# Create logs directory with proper permissions
RUN mkdir -p logs && chown -R disaster-app:nodejs logs

# Switch to non-root user
USER disaster-app

# Expose port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node healthcheck.js

# Start the application
CMD ["node", "server.js"]