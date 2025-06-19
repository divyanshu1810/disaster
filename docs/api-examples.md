# 📚 API Usage Examples

This document provides comprehensive examples of how to use the Disaster Response Platform API.

## 🔐 Authentication

All requests require the `x-user-id` header:

```bash
curl -H "x-user-id: netrunnerX" http://localhost:5000/api/endpoint
```

**Available Users:**
- `netrunnerX` (admin)
- `reliefAdmin` (admin) 
- `contributor1` (contributor)
- `citizen1` (contributor)

## 🏘️ Disaster Management

### Create a New Disaster

```bash
curl -X POST http://localhost:5000/api/disasters \
  -H "Content-Type: application/json" \
  -H "x-user-id: netrunnerX" \
  -d '{
    "title": "California Wildfire 2024",
    "location_name": "Los Angeles County, CA",
    "description": "Large wildfire spreading rapidly through residential areas in Los Angeles County. Multiple evacuation orders issued.",
    "tags": ["fire"],
    "priority_level": 4,
    "affected_population": 50000,
    "estimated_damage": 10000000
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "disaster": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "title": "California Wildfire 2024",
      "location_name": "Los Angeles County, CA",
      "location": "POINT(-118.2437 34.0522)",
      "description": "Large wildfire spreading rapidly...",
      "tags": ["fire"],
      "priority_level": 4,
      "owner_id": "netrunnerX",
      "created_at": "2024-03-15T10:30:00Z"
    },
    "extractedLocations": ["Los Angeles County", "California"],
    "geocodeResult": {
      "provider": "google",
      "confidence": 0.95
    }
  }
}
```

### List Disasters with Filters

```bash
# Get all disasters
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/disasters"

# Filter by tag
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/disasters?tag=fire"

# Filter by priority level
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/disasters?priority_level=4"

# Search by location (within 50km)
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/disasters?location=34.0522,-118.2437&radius=50000"

# Pagination
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/disasters?page=2&limit=10"
```

### Get Disaster Statistics

```bash
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/disasters/123e4567-e89b-12d3-a456-426614174000/stats"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "disaster": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "title": "California Wildfire 2024"
    },
    "counts": {
      "reports": 45,
      "resources": 12,
      "social_media_posts": 128,
      "official_updates": 8
    },
    "reports_by_status": {
      "verified": 23,
      "pending": 15,
      "rejected": 7
    },
    "resources_by_type": {
      "shelter": 5,
      "medical": 3,
      "food": 4
    }
  }
}
```

## 📦 Resource Management

### Create a Resource

```bash
curl -X POST http://localhost:5000/api/resources \
  -H "Content-Type: application/json" \
  -H "x-user-id: reliefAdmin" \
  -d '{
    "disaster_id": "123e4567-e89b-12d3-a456-426614174000",
    "name": "Emergency Shelter - Pasadena",
    "location_name": "Pasadena Community Center, CA",
    "type": "shelter",
    "description": "Large emergency shelter with capacity for 200 people. Provides food, water, and basic medical care.",
    "capacity": 200,
    "current_usage": 45,
    "contact_info": {
      "phone": "+1-626-555-0123",
      "email": "shelter@pasadenacity.gov",
      "coordinator": "Sarah Johnson"
    },
    "availability_hours": {
      "open_24_7": true,
      "special_notes": "Check-in closes at 10 PM"
    }
  }'
```

### Find Nearby Resources

```bash
curl -X POST http://localhost:5000/api/resources/search/nearby \
  -H "Content-Type: application/json" \
  -H "x-user-id: netrunnerX" \
  -d '{
    "lat": 34.0522,
    "lng": -118.2437,
    "distance_km": 25,
    "resource_types": ["shelter", "medical"],
    "limit": 10,
    "include_unavailable": false
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "search_location": {
      "coordinates": [34.0522, -118.2437],
      "location_name": "Los Angeles, CA",
      "formatted_address": "Los Angeles, CA, USA"
    },
    "resources": [
      {
        "id": "resource-id-1",
        "name": "Emergency Shelter - Pasadena",
        "location_name": "Pasadena Community Center, CA",
        "type": "shelter",
        "distance_meters": 15420.5,
        "is_available": true,
        "capacity": 200,
        "current_usage": 45
      }
    ],
    "statistics": {
      "total_found": 1,
      "by_type": {
        "shelter": 1
      },
      "distance_stats": {
        "closest_km": 15.4,
        "furthest_km": 15.4,
        "average_km": 15.4
      }
    }
  }
}
```

### Get Resources for a Disaster

```bash
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/resources/disasters/123e4567-e89b-12d3-a456-426614174000/nearby?distance_km=50"
```

## 🗺️ Geocoding & Location Services

### Geocode a Location

```bash
curl -X POST http://localhost:5000/api/geocoding/geocode \
  -H "Content-Type: application/json" \
  -H "x-user-id: netrunnerX" \
  -d '{
    "location_name": "Manhattan, NYC",
    "extract_from_description": "Heavy flooding reported in the Manhattan area of New York City, particularly around Times Square and Central Park."
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "input": {
      "location_name": "Manhattan, NYC",
      "original_location_name": "Manhattan, NYC",
      "description_provided": true
    },
    "primary_location": "Manhattan, NYC",
    "extracted_locations": ["Manhattan", "New York City", "Times Square", "Central Park"],
    "geocoding_results": [
      {
        "lat": 40.7831,
        "lng": -73.9712,
        "formattedAddress": "Manhattan, NY, USA",
        "placeId": "ChIJYeZuBI9YwokRjMDs_IEyCQQ",
        "confidence": 0.95
      }
    ],
    "provider": "google"
  }
}
```

### Extract Locations from Text

```bash
curl -X POST http://localhost:5000/api/geocoding/extract-locations \
  -H "Content-Type: application/json" \
  -H "x-user-id: netrunnerX" \
  -d '{
    "description": "Severe flooding has been reported across multiple areas including downtown Miami, Fort Lauderdale, and parts of the Florida Keys. Emergency services are responding to calls from Coconut Grove and Coral Gables.",
    "auto_geocode": true
  }'
```

### Batch Geocoding

```bash
curl -X POST http://localhost:5000/api/geocoding/batch-geocode \
  -H "Content-Type: application/json" \
  -H "x-user-id: netrunnerX" \
  -d '{
    "locations": [
      "Downtown Miami, FL",
      "Fort Lauderdale, FL", 
      "Key West, FL",
      "Tampa, FL",
      "Orlando, FL"
    ]
  }'
```

### Reverse Geocoding

```bash
curl -X POST http://localhost:5000/api/geocoding/reverse \
  -H "Content-Type: application/json" \
  -H "x-user-id: netrunnerX" \
  -d '{
    "lat": 40.7128,
    "lng": -74.0060
  }'
```

## 📱 Social Media Monitoring

### Fetch Social Media Reports for a Disaster

```bash
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/social-media/disasters/123e4567-e89b-12d3-a456-426614174000/reports?max_results=20&time_window=24&filter_urgent=true"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "disaster": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "title": "California Wildfire 2024",
      "location_name": "Los Angeles County, CA"
    },
    "posts": [
      {
        "id": "post_123",
        "content": "URGENT: Family trapped in Malibu due to wildfire. Roads blocked, need immediate rescue assistance! #CAFire #Emergency",
        "author": "concerned_citizen",
        "createdAt": "2024-03-15T14:30:00Z",
        "platform": "twitter",
        "isUrgent": true,
        "classification": "help_request",
        "keywords": ["urgent", "trapped", "rescue", "emergency"],
        "relevanceScore": 0.95,
        "metrics": {
          "likes": 45,
          "retweets": 23,
          "replies": 12
        }
      }
    ],
    "metadata": {
      "total_posts": 1,
      "urgent_posts": 1,
      "platforms": ["twitter"],
      "provider": "mock"
    }
  }
}
```

### Analyze a Social Media Post

```bash
curl -X POST http://localhost:5000/api/social-media/analyze-post \
  -H "Content-Type: application/json" \
  -H "x-user-id: netrunnerX" \
  -d '{
    "content": "SOS! Stuck on roof due to flooding on Main Street. Water rising fast, need rescue boat ASAP! #FloodEmergency",
    "disaster_context": {
      "location_name": "Houston, TX",
      "tags": ["flood"],
      "description": "Major flooding in Houston due to heavy rainfall"
    }
  }'
```

### Get Trending Keywords

```bash
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/social-media/trending?time_window=24&min_mentions=5"
```

## ✅ Image Verification

### Verify an Image

```bash
curl -X POST http://localhost:5000/api/verification/verify-image \
  -H "Content-Type: application/json" \
  -H "x-user-id: netrunnerX" \
  -d '{
    "image_url": "https://example.com/disaster-photo.jpg",
    "context": "Photo claiming to show wildfire damage in Los Angeles County",
    "disaster_id": "123e4567-e89b-12d3-a456-426614174000"
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "verification": {
      "isAuthentic": true,
      "confidence": 87,
      "reasoning": "Image appears authentic with consistent lighting and shadows. Metadata indicates recent capture timestamp. Context matches expected wildfire damage patterns.",
      "redFlags": [],
      "contextMatch": true,
      "recommendations": "Image appears authentic but manual review recommended for critical decisions."
    },
    "metadata": {
      "verified_by": "netrunnerX",
      "verified_at": "2024-03-15T15:45:00Z",
      "ai_provider": "google_gemini"
    }
  }
}
```

### Batch Verify Multiple Images

```bash
curl -X POST http://localhost:5000/api/verification/batch-verify \
  -H "Content-Type: application/json" \
  -H "x-user-id: netrunnerX" \
  -d '{
    "verifications": [
      {
        "image_url": "https://example.com/photo1.jpg",
        "context": "Flood damage in downtown area"
      },
      {
        "image_url": "https://example.com/photo2.jpg", 
        "context": "Evacuation center setup"
      }
    ]
  }'
```

### Get Verification Statistics

```bash
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/verification/stats?time_window=168&disaster_id=123e4567-e89b-12d3-a456-426614174000"
```

## 📰 Official Updates

### Get Official Updates for a Disaster

```bash
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/official-updates/disasters/123e4567-e89b-12d3-a456-426614174000?sources=fema,redcross&max_results=10&priority_only=true"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "disaster": {
      "id": "123e4567-e89b-12d3-a456-426614174000",
      "title": "California Wildfire 2024",
      "location_name": "Los Angeles County, CA"
    },
    "updates": [
      {
        "title": "FEMA Approves Emergency Declaration for Los Angeles County Wildfire",
        "content": "Federal Emergency Management Agency approves emergency declaration, unlocking federal resources for wildfire response efforts...",
        "url": "https://www.fema.gov/press-release/...",
        "source": "FEMA",
        "publishedAt": "2024-03-15T16:00:00Z",
        "updateType": "alert",
        "priorityLevel": 5
      }
    ],
    "metadata": {
      "total_updates": 1,
      "priority_updates": 1,
      "sources_queried": ["fema", "redcross"]
    }
  }
}
```

### Search Official Updates by Keywords

```bash
curl -X POST http://localhost:5000/api/official-updates/search \
  -H "Content-Type: application/json" \
  -H "x-user-id: netrunnerX" \
  -d '{
    "keywords": ["evacuation", "wildfire", "emergency"],
    "sources": ["fema", "redcross"],
    "max_results": 15,
    "time_window": 72
  }'
```

### Refresh All Disaster Updates

```bash
curl -X POST http://localhost:5000/api/official-updates/refresh-all \
  -H "Content-Type: application/json" \
  -H "x-user-id: netrunnerX" \
  -d '{
    "max_disasters": 5,
    "time_window": 48,
    "sources": ["fema", "redcross", "nws"]
  }'
```

## 🔍 Health & Service Information

### Health Check

```bash
curl http://localhost:5000/health
```

**Response:**
```json
{
  "status": "OK",
  "timestamp": "2024-03-15T17:00:00Z",
  "version": "1.0.0"
}
```

### Get Geocoding Service Info

```bash
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/geocoding/service-info"
```

### Get Social Media Service Info

```bash
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/social-media/service-info"
```

### Get Official Updates Sources

```bash
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/official-updates/sources"
```

## 🔄 Real-time WebSocket Events

### JavaScript Client Example

```javascript
// Connect to WebSocket
const socket = io('http://localhost:5000');

// Listen for connection
socket.on('connect', () => {
    console.log('Connected to disaster response platform');
    
    // Join specific disaster room for updates
    socket.emit('join_disaster', 'disaster-id-here');
});

// Listen for disaster events
socket.on('disaster_created', (data) => {
    console.log('New disaster created:', data.disaster.title);
    console.log('Created by:', data.user);
});

socket.on('disaster_updated', (data) => {
    console.log('Disaster updated:', data.disaster.title);
    console.log('Updated by:', data.updatedBy);
    console.log('Changes:', data.changes);
});

// Listen for resource events
socket.on('resource_created', (data) => {
    console.log('New resource:', data.resource.name);
});

socket.on('resources_updated', (data) => {
    console.log('Resources updated for disaster:', data.disasterId);
    console.log('Action:', data.action);
});

// Listen for social media updates
socket.on('social_media_updated', (data) => {
    console.log(`New social media activity:`);
    console.log(`- ${data.newPosts} new posts`);
    console.log(`- ${data.urgentPosts} urgent posts`);
    console.log(`- Provider: ${data.provider}`);
});

// Listen for verification events
socket.on('report_verified', (data) => {
    console.log('Report verified:', data.reportId);
    console.log('Status:', data.verificationStatus);
    console.log('Verified by:', data.verifiedBy);
});

// Listen for official updates
socket.on('official_updates_received', (data) => {
    console.log(`${data.newUpdates} new official updates`);
    console.log(`${data.priorityUpdates} priority updates`);
    console.log('Sources:', data.sources);
});

// Handle disconnection
socket.on('disconnect', () => {
    console.log('Disconnected from platform');
});
```

## 📊 Advanced Queries

### Complex Disaster Search

```bash
# Find high-priority active disasters with resources within 100km of coordinates
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/disasters?is_active=true&priority_level=4&location=34.0522,-118.2437&radius=100000&include_reports=true&include_resources=true"
```

### Multi-criteria Resource Search

```bash
curl -X POST http://localhost:5000/api/resources/search/nearby \
  -H "Content-Type: application/json" \
  -H "x-user-id: netrunnerX" \
  -d '{
    "lat": 34.0522,
    "lng": -118.2437,
    "distance_km": 50,
    "resource_types": ["shelter", "medical", "food"],
    "disaster_id": "123e4567-e89b-12d3-a456-426614174000",
    "include_unavailable": false,
    "limit": 25
  }'
```

### Comprehensive Analytics Query

```bash
# Get platform-wide statistics
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/disasters/stats" \
  | jq '.data | {
      total_disasters: .disasters.total,
      active_disasters: .disasters.active,
      total_resources: .resources.total,
      pending_verifications: .reports.pending
    }'
```

## 🚨 Error Handling

### Common Error Responses

**401 Unauthorized:**
```json
{
  "error": "Authentication required",
  "message": "Please provide x-user-id header"
}
```

**403 Forbidden:**
```json
{
  "error": "Insufficient permissions",
  "required": ["update"],
  "current": ["read", "create"]
}
```

**404 Not Found:**
```json
{
  "error": "Disaster not found"
}
```

**400 Bad Request:**
```json
{
  "error": "Validation error: tags is required"
}
```

**500 Internal Server Error:**
```json
{
  "error": "Database operation failed",
  "message": "Unable to connect to database"
}
```

## 🔧 Tips for Testing

### Using curl with jq for JSON formatting

```bash
# Pretty print JSON responses
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/disasters" | jq '.'

# Extract specific fields
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/disasters" | jq '.data[].title'

# Filter results
curl -H "x-user-id: netrunnerX" \
  "http://localhost:5000/api/disasters" | jq '.data[] | select(.priority_level >= 4)'
```

### Testing Real-time Features

1. **Open multiple terminal windows**
2. **In terminal 1:** Start monitoring WebSocket events with a simple Node.js script
3. **In terminal 2:** Make API calls that trigger events
4. **Observe:** Real-time updates in terminal 1

### Environment-specific Testing

```bash
# Development
API_BASE="http://localhost:5000" ./test-script.sh

# Staging  
API_BASE="https://your-staging-url.com" ./test-script.sh

# Production
API_BASE="https://your-production-url.com" ./test-script.sh
```

This comprehensive guide covers all major API endpoints and usage patterns. For additional examples or specific use cases, refer to the frontend test interface at `http://localhost:5000` when running the platform.