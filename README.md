# 🚨 Disaster Response Platform

A comprehensive backend-heavy MERN stack application for real-time disaster management, resource coordination, and emergency response. Built with modern technologies and AI-powered features for efficient disaster response operations.

![Platform Overview](https://img.shields.io/badge/Node.js-v18+-green) ![Express](https://img.shields.io/badge/Express-4.18+-blue) ![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-orange) ![Socket.IO](https://img.shields.io/badge/Socket.IO-Real--time-red)

## 🎯 Features

### 🏘️ **Disaster Data Management**
- **CRUD Operations**: Complete disaster lifecycle management with ownership tracking
- **Location Intelligence**: AI-powered location extraction using Google Gemini API
- **Geospatial Queries**: PostGIS-based location searches and proximity analysis
- **Audit Trail**: Complete change tracking with user attribution
- **Priority System**: 1-5 priority levels with automatic escalation

### 🗺️ **Location Extraction & Geocoding**
- **AI Location Extraction**: Extract location names from disaster descriptions using Google Gemini
- **Multi-Provider Geocoding**: Support for Google Maps, Mapbox, and OpenStreetMap
- **Batch Processing**: Geocode multiple locations simultaneously
- **Coordinate Validation**: Verify coordinate accuracy and reasonableness
- **Reverse Geocoding**: Convert coordinates back to readable addresses

### 📱 **Real-Time Social Media Monitoring**
- **Multi-Platform Support**: Twitter API, Bluesky, and mock data sources
- **Urgency Detection**: AI-powered identification of urgent posts using keyword analysis
- **Sentiment Classification**: Automatic categorization of posts (help requests, offers, information)
- **Real-time Processing**: Live monitoring with WebSocket updates
- **Trend Analysis**: Identify trending disaster-related keywords and locations

### 🗺️ **Geospatial Resource Mapping**
- **Proximity Search**: Find resources within specified distance using PostGIS
- **Resource Types**: Shelters, food, water, medical, rescue, transport, power, communication
- **Capacity Management**: Track resource utilization and availability
- **Contact Integration**: Store and manage resource contact information
- **Real-time Updates**: Live resource status updates via WebSockets

### 📰 **Official Updates Aggregation**
- **Multi-Source Scraping**: FEMA, Red Cross, CDC, National Weather Service
- **Intelligent Filtering**: Relevance-based content filtering
- **Priority Classification**: Automatic priority assignment based on content
- **Content Caching**: Efficient storage with TTL-based expiration
- **Trending Analysis**: Identify trending topics from official sources

### ✅ **Image Verification**
- **AI-Powered Analysis**: Google Gemini API for authenticity detection
- **Context Matching**: Verify images against disaster context
- **Batch Processing**: Verify multiple images simultaneously
- **Manual Override**: Human verification with admin controls
- **Audit Trail**: Complete verification history tracking

### ⚡ **Backend Optimization**
- **Intelligent Caching**: Supabase-based caching with configurable TTL
- **Geospatial Indexing**: Optimized PostGIS indexes for fast location queries
- **Structured Logging**: Comprehensive logging with Winston
- **Rate Limiting**: API protection with configurable limits
- **Error Handling**: Comprehensive error handling and recovery

## 🛠️ Tech Stack

### Backend
- **Runtime**: Node.js 18+
- **Framework**: Express.js 4.18+
- **Database**: Supabase (PostgreSQL + PostGIS)
- **Real-time**: Socket.IO 4.7+
- **Authentication**: Mock users (extensible to real auth)

### External APIs
- **AI**: Google Gemini API (location extraction, image verification)
- **Geocoding**: Google Maps API, Mapbox, OpenStreetMap Nominatim
- **Social Media**: Twitter API v2, Bluesky API, Mock data
- **Web Scraping**: Cheerio for official updates

### DevOps & Deployment
- **Caching**: Supabase-based with automatic cleanup
- **Logging**: Winston with structured JSON logging
- **Monitoring**: Health checks and real-time status
- **Rate Limiting**: Express rate limiter
- **Security**: Helmet.js, CORS, input validation

## 🚀 Quick Start

### Prerequisites
- Node.js 18.0 or higher
- NPM or Yarn package manager
- Supabase account and project
- Google Cloud Platform account (for Gemini API)

### 1. Clone and Install
```bash
git clone <repository-url>
cd disaster-response-platform
npm install
```

### 2. Environment Setup
Create a `.env` file in the root directory:

```bash
# Server Configuration
PORT=5000
NODE_ENV=development

# Supabase Configuration
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_KEY=your_supabase_service_role_key

# Google Gemini API
GEMINI_API_KEY=your_gemini_api_key

# Geocoding Services (choose one or more)
GOOGLE_MAPS_API_KEY=your_google_maps_api_key
MAPBOX_ACCESS_TOKEN=your_mapbox_token

# Social Media APIs (optional)
TWITTER_BEARER_TOKEN=your_twitter_bearer_token
BLUESKY_USERNAME=your_bluesky_handle
BLUESKY_PASSWORD=your_bluesky_password

# Configuration
CACHE_TTL=3600
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

### 3. Database Setup

#### Supabase Setup
1. Create a new Supabase project at [supabase.com](https://supabase.com)
2. Go to Settings → API to get your URL and keys
3. Navigate to the SQL Editor in your Supabase dashboard
4. Run the schema setup:

```sql
-- Copy and paste the contents of database/schema.sql
-- Then run database/functions.sql
```

#### Enable PostGIS
```sql
-- Enable PostGIS extension (run in SQL Editor)
CREATE EXTENSION IF NOT EXISTS postgis;
```

### 4. API Keys Setup

#### Google Gemini API
1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Create a new API key
3. Add it to your `.env` file as `GEMINI_API_KEY`

#### Google Maps Geocoding (Optional)
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Enable the Geocoding API
3. Create credentials and add as `GOOGLE_MAPS_API_KEY`

#### Mapbox (Alternative to Google Maps)
1. Sign up at [Mapbox](https://www.mapbox.com)
2. Get your access token
3. Add as `MAPBOX_ACCESS_TOKEN`

### 5. Start the Application
```bash
# Development mode with hot reload
npm run dev

# Production mode
npm start
```

### 6. Access the Application
- **Backend API**: http://localhost:5000
- **Frontend Interface**: http://localhost:5000 (serves the built-in test interface)
- **Health Check**: http://localhost:5000/health

## 📚 API Documentation

### Authentication
All API requests require the `x-user-id` header with one of the mock users:
- `netrunnerX` (admin)
- `reliefAdmin` (admin)
- `contributor1` (contributor)
- `citizen1` (contributor)

### Core Endpoints

#### Disasters
```http
POST   /api/disasters                    # Create disaster
GET    /api/disasters                    # List disasters (with filters)
GET    /api/disasters/:id               # Get specific disaster
PUT    /api/disasters/:id               # Update disaster
DELETE /api/disasters/:id               # Delete disaster
GET    /api/disasters/:id/stats         # Get disaster statistics
```

#### Resources
```http
POST   /api/resources                   # Create resource
GET    /api/resources                   # List resources
GET    /api/resources/:id               # Get specific resource
PUT    /api/resources/:id               # Update resource
DELETE /api/resources/:id               # Delete resource
GET    /api/resources/disasters/:id/nearby  # Get nearby resources
POST   /api/resources/search/nearby     # Search resources by coordinates
```

#### Geocoding
```http
POST   /api/geocoding/geocode           # Convert location name to coordinates
POST   /api/geocoding/reverse           # Convert coordinates to location name
POST   /api/geocoding/extract-locations # Extract locations from text
POST   /api/geocoding/batch-geocode     # Batch geocode multiple locations
```

#### Social Media
```http
GET    /api/social-media/disasters/:id/reports  # Get social media reports
POST   /api/social-media/analyze-post            # Analyze post content
GET    /api/social-media/trending                # Get trending keywords
POST   /api/social-media/bulk-fetch              # Bulk fetch for multiple disasters
```

#### Verification
```http
POST   /api/verification/verify-image    # Verify image authenticity
GET    /api/verification/reports/:id/status  # Get verification status
PUT    /api/verification/reports/:id/status  # Update verification status
GET    /api/verification/stats           # Get verification statistics
```

#### Official Updates
```http
GET    /api/official-updates/disasters/:id  # Get official updates for disaster
POST   /api/official-updates/search         # Search updates by keywords
GET    /api/official-updates/sources        # Get available sources
POST   /api/official-updates/refresh-all    # Refresh all disaster updates
```

### WebSocket Events
The platform provides real-time updates via Socket.IO:

```javascript
// Client-side Socket.IO connection
const socket = io();

// Listen for disaster events
socket.on('disaster_created', (data) => {
    console.log('New disaster:', data.disaster.title);
});

socket.on('disaster_updated', (data) => {
    console.log('Disaster updated:', data.disaster.title);
});

// Listen for resource events
socket.on('resource_created', (data) => {
    console.log('New resource:', data.resource.name);
});

// Listen for social media updates
socket.on('social_media_updated', (data) => {
    console.log(`${data.newPosts} new posts, ${data.urgentPosts} urgent`);
});

// Listen for verification events
socket.on('report_verified', (data) => {
    console.log('Report verified:', data.verificationStatus);
});
```

## 🧪 Testing the Platform

### Using the Built-in Frontend
1. Start the server: `npm run dev`
2. Navigate to `http://localhost:5000`
3. Test all features using the web interface

### API Testing with cURL

#### Create a Disaster
```bash
curl -X POST http://localhost:5000/api/disasters \
  -H "Content-Type: application/json" \
  -H "x-user-id: netrunnerX" \
  -d '{
    "title": "NYC Flood Emergency",
    "location_name": "Manhattan, NYC", 
    "description": "Heavy flooding in Manhattan due to severe rainfall",
    "tags": ["flood"]
  }'
```

#### Geocode a Location
```bash
curl -X POST http://localhost:5000/api/geocoding/geocode \
  -H "Content-Type: application/json" \
  -H "x-user-id: netrunnerX" \
  -d '{
    "location_name": "Manhattan, NYC"
  }'
```

#### Find Nearby Resources
```bash
curl -X POST http://localhost:5000/api/resources/search/nearby \
  -H "Content-Type: application/json" \
  -H "x-user-id: netrunnerX" \
  -d '{
    "lat": 40.7831,
    "lng": -73.9712,
    "distance_km": 10
  }'
```

## 🚀 Deployment

### Render.com Deployment

1. **Prepare for Deployment**
   ```bash
   # Ensure your package.json has the start script
   # "start": "node server.js"
   ```

2. **Create Render Service**
   - Connect your GitHub repository
   - Set environment variables in Render dashboard
   - Choose Node.js environment

3. **Environment Variables for Render**
   ```
   NODE_ENV=production
   PORT=5000
   SUPABASE_URL=your_production_supabase_url
   SUPABASE_ANON_KEY=your_production_anon_key
   GEMINI_API_KEY=your_gemini_key
   GOOGLE_MAPS_API_KEY=your_maps_key
   ```

### Vercel Deployment (Frontend Only)

For deploying just the frontend interface:

1. **Install Vercel CLI**
   ```bash
   npm i -g vercel
   ```

2. **Deploy**
   ```bash
   # From the project root
   vercel --prod
   ```

### Docker Deployment

Build and run with Docker:

```bash
# Build the image
docker build -t disaster-response-platform .

# Run the container
docker run -p 5000:5000 --env-file .env disaster-response-platform
```

## 🔧 Development

### Project Structure
```
disaster-response-platform/
├── server.js                 # Main server entry point
├── package.json              # Dependencies and scripts
├── .env.example              # Environment variables template
├── public/                   # Frontend static files
│   └── index.html           # Test interface
├── config/                   # Configuration files
│   └── supabase.js          # Database configuration
├── middleware/               # Express middleware
│   ├── auth.js              # Authentication (mock)
│   └── errorHandler.js      # Error handling
├── routes/                   # API route handlers
│   ├── disasters.js         # Disaster management
│   ├── resources.js         # Resource management
│   ├── geocoding.js         # Location services
│   ├── socialMedia.js       # Social media monitoring
│   ├── verification.js      # Image verification
│   └── officialUpdates.js   # Official updates
├── services/                 # External service integrations
│   ├── gemini.js            # Google Gemini API
│   ├── geocoding.js         # Geocoding services
│   ├── socialMedia.js       # Social media APIs
│   └── officialUpdates.js   # Web scraping
├── utils/                    # Utility functions
│   ├── logger.js            # Structured logging
│   └── cache.js             # Cache management
└── database/                 # Database files
    ├── schema.sql           # Database schema
    └── functions.sql        # Custom functions
```

### Adding New Features

1. **Create API Route**
   ```javascript
   // routes/newFeature.js
   const express = require('express');
   const router = express.Router();
   
   router.get('/', (req, res) => {
       res.json({ message: 'New feature endpoint' });
   });
   
   module.exports = router;
   ```

2. **Register Route**
   ```javascript
   // server.js
   const newFeatureRoutes = require('./routes/newFeature');
   app.use('/api/new-feature', newFeatureRoutes);
   ```

3. **Add Database Changes**
   ```sql
   -- database/new_feature.sql
   CREATE TABLE new_feature_table (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       -- ... other columns
   );
   ```

### Testing Guidelines

1. **Manual Testing**: Use the built-in frontend at `http://localhost:5000`
2. **API Testing**: Use Postman, cURL, or similar tools
3. **Database Testing**: Use Supabase dashboard SQL editor
4. **Real-time Testing**: Open multiple browser tabs to test WebSocket events

## 🔍 Monitoring & Maintenance

### Health Checks
- **API Health**: `GET /health`
- **Database Health**: Automatic connection testing
- **Service Health**: Individual service health checks

### Logging
- **Structured Logging**: JSON format with Winston
- **Log Levels**: Error, Warn, Info, Debug
- **Log Files**: `logs/error.log`, `logs/combined.log`

### Cache Management
- **Automatic Cleanup**: Expired entries removed automatically
- **Manual Cleanup**: `GET /api/admin/cleanup-cache` (if implemented)
- **Cache Statistics**: Monitor hit rates and usage

### Performance Monitoring
- **Database Indexes**: Geospatial and standard indexes optimized
- **Rate Limiting**: Configurable per-endpoint limits
- **Connection Pooling**: Automatic via Supabase

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/new-feature`
3. Make your changes and test thoroughly
4. Commit with descriptive messages: `git commit -m "Add new feature"`
5. Push to your branch: `git push origin feature/new-feature`
6. Create a Pull Request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

For support and questions:
- **Issues**: Create a GitHub issue
- **Documentation**: Check this README and inline code comments
- **API Reference**: Use the built-in frontend for interactive testing

## 🎯 Roadmap

### Phase 1 (Current)
- ✅ Core disaster management
- ✅ Geospatial resource mapping
- ✅ AI-powered location extraction
- ✅ Social media monitoring
- ✅ Image verification
- ✅ Official updates aggregation

### Phase 2 (Future)
- 📱 Mobile app integration
- 🔐 Full authentication system
- 📊 Advanced analytics dashboard
- 🌐 Multi-language support
- 🔔 Push notifications
- 📡 IoT sensor integration

### Phase 3 (Future)
- 🤖 Advanced AI predictions
- 🗺️ 3D visualization
- 📈 Machine learning insights
- 🌍 Global deployment
- 🔌 Third-party integrations
- 📚 API marketplace

---

**Built with ❤️ for disaster response and emergency management**