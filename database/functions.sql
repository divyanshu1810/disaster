-- Additional PostGIS and utility functions for the disaster response platform

-- Function to find disasters within a certain distance
CREATE OR REPLACE FUNCTION find_disasters_within_distance(
    lat FLOAT,
    lng FLOAT,
    distance_meters INTEGER DEFAULT 10000
)
RETURNS TABLE (
    id UUID,
    title VARCHAR(255),
    location_name TEXT,
    description TEXT,
    tags disaster_tag[],
    priority_level INTEGER,
    distance_meters FLOAT,
    created_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        d.id,
        d.title,
        d.location_name,
        d.description,
        d.tags,
        d.priority_level,
        ST_Distance(d.location::geometry, ST_SetSRID(ST_Point(lng, lat), 4326)::geometry) as distance_meters,
        d.created_at
    FROM disasters d
    WHERE 
        d.location IS NOT NULL
        AND d.is_active = true
        AND ST_DWithin(
            d.location::geometry, 
            ST_SetSRID(ST_Point(lng, lat), 4326)::geometry, 
            distance_meters
        )
    ORDER BY distance_meters;
END;
$$ language 'plpgsql';

-- Function to get disaster statistics
CREATE OR REPLACE FUNCTION get_disaster_statistics(disaster_id UUID)
RETURNS JSON AS $$
DECLARE
    result JSON;
BEGIN
    SELECT json_build_object(
        'disaster_id', disaster_id,
        'reports_count', (
            SELECT COUNT(*) FROM reports WHERE reports.disaster_id = get_disaster_statistics.disaster_id
        ),
        'verified_reports', (
            SELECT COUNT(*) FROM reports 
            WHERE reports.disaster_id = get_disaster_statistics.disaster_id 
            AND verification_status = 'verified'
        ),
        'pending_reports', (
            SELECT COUNT(*) FROM reports 
            WHERE reports.disaster_id = get_disaster_statistics.disaster_id 
            AND verification_status = 'pending'
        ),
        'resources_count', (
            SELECT COUNT(*) FROM resources WHERE resources.disaster_id = get_disaster_statistics.disaster_id
        ),
        'available_resources', (
            SELECT COUNT(*) FROM resources 
            WHERE resources.disaster_id = get_disaster_statistics.disaster_id 
            AND is_available = true
        ),
        'social_media_posts', (
            SELECT COUNT(*) FROM social_media_posts 
            WHERE social_media_posts.disaster_id = get_disaster_statistics.disaster_id
        ),
        'urgent_posts', (
            SELECT COUNT(*) FROM social_media_posts 
            WHERE social_media_posts.disaster_id = get_disaster_statistics.disaster_id 
            AND sentiment = 'urgent'
        ),
        'official_updates', (
            SELECT COUNT(*) FROM official_updates 
            WHERE official_updates.disaster_id = get_disaster_statistics.disaster_id
        ),
        'priority_updates', (
            SELECT COUNT(*) FROM official_updates 
            WHERE official_updates.disaster_id = get_disaster_statistics.disaster_id 
            AND priority_level >= 4
        )
    ) INTO result;
    
    RETURN result;
END;
$$ language 'plpgsql';

-- Function to calculate resource utilization
CREATE OR REPLACE FUNCTION calculate_resource_utilization()
RETURNS TABLE (
    resource_type resource_type,
    total_resources BIGINT,
    available_resources BIGINT,
    total_capacity BIGINT,
    current_usage BIGINT,
    utilization_percentage FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        r.type as resource_type,
        COUNT(*) as total_resources,
        COUNT(*) FILTER (WHERE r.is_available = true) as available_resources,
        COALESCE(SUM(r.capacity), 0) as total_capacity,
        COALESCE(SUM(r.current_usage), 0) as current_usage,
        CASE 
            WHEN COALESCE(SUM(r.capacity), 0) > 0 
            THEN (COALESCE(SUM(r.current_usage), 0)::FLOAT / SUM(r.capacity)::FLOAT) * 100
            ELSE 0
        END as utilization_percentage
    FROM resources r
    GROUP BY r.type
    ORDER BY utilization_percentage DESC;
END;
$$ language 'plpgsql';

-- Function to find resources by type within distance
CREATE OR REPLACE FUNCTION find_resources_by_type_and_distance(
    lat FLOAT,
    lng FLOAT,
    resource_types resource_type[],
    distance_meters INTEGER DEFAULT 10000,
    include_unavailable BOOLEAN DEFAULT false
)
RETURNS TABLE (
    id UUID,
    name VARCHAR(255),
    location_name TEXT,
    type resource_type,
    capacity INTEGER,
    current_usage INTEGER,
    is_available BOOLEAN,
    distance_meters FLOAT,
    contact_info JSONB
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        r.id,
        r.name,
        r.location_name,
        r.type,
        r.capacity,
        r.current_usage,
        r.is_available,
        ST_Distance(r.location::geometry, ST_SetSRID(ST_Point(lng, lat), 4326)::geometry) as distance_meters,
        r.contact_info
    FROM resources r
    WHERE 
        r.location IS NOT NULL
        AND (resource_types IS NULL OR r.type = ANY(resource_types))
        AND (include_unavailable = true OR r.is_available = true)
        AND ST_DWithin(
            r.location::geometry, 
            ST_SetSRID(ST_Point(lng, lat), 4326)::geometry, 
            distance_meters
        )
    ORDER BY distance_meters;
END;
$$ language 'plpgsql';

-- Function to update resource usage
CREATE OR REPLACE FUNCTION update_resource_usage(
    resource_id UUID,
    usage_change INTEGER
)
RETURNS BOOLEAN AS $$
DECLARE
    current_capacity INTEGER;
    current_usage_val INTEGER;
    new_usage INTEGER;
BEGIN
    -- Get current values
    SELECT capacity, current_usage 
    INTO current_capacity, current_usage_val
    FROM resources 
    WHERE id = resource_id;
    
    -- Check if resource exists
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    
    -- Calculate new usage
    new_usage := COALESCE(current_usage_val, 0) + usage_change;
    
    -- Ensure usage doesn't go below 0 or above capacity
    new_usage := GREATEST(0, new_usage);
    IF current_capacity IS NOT NULL THEN
        new_usage := LEAST(current_capacity, new_usage);
    END IF;
    
    -- Update the resource
    UPDATE resources 
    SET 
        current_usage = new_usage,
        updated_at = NOW(),
        is_available = CASE 
            WHEN current_capacity IS NOT NULL AND new_usage >= current_capacity THEN false
            ELSE true
        END
    WHERE id = resource_id;
    
    RETURN TRUE;
END;
$$ language 'plpgsql';

-- Function to get trending disaster keywords
CREATE OR REPLACE FUNCTION get_trending_disaster_keywords(
    hours_back INTEGER DEFAULT 24,
    min_occurrences INTEGER DEFAULT 3
)
RETURNS TABLE (
    keyword TEXT,
    occurrences BIGINT,
    trend_score FLOAT
) AS $$
BEGIN
    RETURN QUERY
    WITH keyword_mentions AS (
        SELECT 
            unnest(keywords) as keyword,
            COUNT(*) as count
        FROM social_media_posts 
        WHERE processed_at >= NOW() - INTERVAL '1 hour' * hours_back
        GROUP BY unnest(keywords)
        HAVING COUNT(*) >= min_occurrences
    )
    SELECT 
        km.keyword,
        km.count as occurrences,
        (km.count::FLOAT / hours_back::FLOAT) as trend_score
    FROM keyword_mentions km
    ORDER BY trend_score DESC, occurrences DESC;
END;
$$ language 'plpgsql';

-- Function to archive old data
CREATE OR REPLACE FUNCTION archive_old_data(
    days_to_keep INTEGER DEFAULT 365
)
RETURNS JSON AS $$
DECLARE
    cutoff_date TIMESTAMP WITH TIME ZONE;
    archived_count JSON;
BEGIN
    cutoff_date := NOW() - INTERVAL '1 day' * days_to_keep;
    
    -- Archive old cache entries
    DELETE FROM cache WHERE expires_at < NOW();
    
    -- Archive old social media posts (but keep those linked to active disasters)
    WITH archived_posts AS (
        DELETE FROM social_media_posts 
        WHERE processed_at < cutoff_date 
        AND disaster_id NOT IN (
            SELECT id FROM disasters WHERE is_active = true
        )
        RETURNING *
    )
    SELECT json_build_object(
        'archived_social_posts', (SELECT COUNT(*) FROM archived_posts),
        'cutoff_date', cutoff_date,
        'operation_completed_at', NOW()
    ) INTO archived_count;
    
    RETURN archived_count;
END;
$$ language 'plpgsql';

-- Function to generate disaster summary report
CREATE OR REPLACE FUNCTION generate_disaster_summary(disaster_id UUID)
RETURNS JSON AS $$
DECLARE
    disaster_info JSON;
    summary JSON;
BEGIN
    -- Get disaster basic info
    SELECT to_json(d.*) INTO disaster_info
    FROM disasters d 
    WHERE d.id = disaster_id;
    
    IF disaster_info IS NULL THEN
        RETURN json_build_object('error', 'Disaster not found');
    END IF;
    
    -- Build comprehensive summary
    SELECT json_build_object(
        'disaster', disaster_info,
        'statistics', get_disaster_statistics(disaster_id),
        'recent_activity', json_build_object(
            'reports_last_24h', (
                SELECT COUNT(*) FROM reports 
                WHERE disaster_id = generate_disaster_summary.disaster_id 
                AND created_at >= NOW() - INTERVAL '24 hours'
            ),
            'social_posts_last_24h', (
                SELECT COUNT(*) FROM social_media_posts 
                WHERE disaster_id = generate_disaster_summary.disaster_id 
                AND processed_at >= NOW() - INTERVAL '24 hours'
            ),
            'official_updates_last_24h', (
                SELECT COUNT(*) FROM official_updates 
                WHERE disaster_id = generate_disaster_summary.disaster_id 
                AND fetched_at >= NOW() - INTERVAL '24 hours'
            )
        ),
        'resource_summary', (
            SELECT json_agg(
                json_build_object(
                    'type', type,
                    'count', COUNT(*),
                    'available', COUNT(*) FILTER (WHERE is_available = true)
                )
            )
            FROM resources 
            WHERE disaster_id = generate_disaster_summary.disaster_id
            GROUP BY type
        ),
        'verification_summary', (
            SELECT json_build_object(
                'total', COUNT(*),
                'verified', COUNT(*) FILTER (WHERE verification_status = 'verified'),
                'rejected', COUNT(*) FILTER (WHERE verification_status = 'rejected'),
                'pending', COUNT(*) FILTER (WHERE verification_status = 'pending'),
                'flagged', COUNT(*) FILTER (WHERE verification_status = 'flagged')
            )
            FROM reports 
            WHERE disaster_id = generate_disaster_summary.disaster_id
        ),
        'generated_at', NOW()
    ) INTO summary;
    
    RETURN summary;
END;
$$ language 'plpgsql';

-- Function to clean up expired sessions and temporary data
CREATE OR REPLACE FUNCTION cleanup_expired_data()
RETURNS JSON AS $$
DECLARE
    cleanup_result JSON;
    deleted_cache INTEGER;
    deleted_temp_reports INTEGER;
BEGIN
    -- Clean expired cache
    DELETE FROM cache WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_cache = ROW_COUNT;
    
    -- Clean up temporary/test reports older than 7 days
    DELETE FROM reports 
    WHERE created_at < NOW() - INTERVAL '7 days' 
    AND (content LIKE '%test%' OR content LIKE '%temporary%');
    GET DIAGNOSTICS deleted_temp_reports = ROW_COUNT;
    
    SELECT json_build_object(
        'deleted_cache_entries', deleted_cache,
        'deleted_temp_reports', deleted_temp_reports,
        'cleanup_completed_at', NOW()
    ) INTO cleanup_result;
    
    RETURN cleanup_result;
END;
$$ language 'plpgsql';

-- Function to validate disaster location coordinates
CREATE OR REPLACE FUNCTION validate_disaster_coordinates()
RETURNS TABLE (
    disaster_id UUID,
    title VARCHAR(255),
    location_name TEXT,
    has_valid_coordinates BOOLEAN,
    coordinates_text TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        d.id as disaster_id,
        d.title,
        d.location_name,
        (d.location IS NOT NULL) as has_valid_coordinates,
        CASE 
            WHEN d.location IS NOT NULL 
            THEN ST_AsText(d.location::geometry)
            ELSE NULL
        END as coordinates_text
    FROM disasters d
    WHERE d.is_active = true
    ORDER BY d.created_at DESC;
END;
$$ language 'plpgsql';

-- Create a scheduled job function to run cleanup (to be used with pg_cron if available)
CREATE OR REPLACE FUNCTION scheduled_maintenance()
RETURNS JSON AS $$
DECLARE
    maintenance_result JSON;
BEGIN
    -- Run cleanup
    SELECT cleanup_expired_data() INTO maintenance_result;
    
    -- Log maintenance activity
    INSERT INTO cache (key, value, expires_at, source) 
    VALUES (
        'last_maintenance',
        json_build_object(
            'completed_at', NOW(),
            'cleanup_result', maintenance_result
        ),
        NOW() + INTERVAL '30 days',
        'system'
    );
    
    RETURN maintenance_result;
END;
$$ language 'plpgsql';

-- Function to get real-time platform statistics
CREATE OR REPLACE FUNCTION get_platform_statistics()
RETURNS JSON AS $$
DECLARE
    stats JSON;
BEGIN
    SELECT json_build_object(
        'disasters', json_build_object(
            'total', (SELECT COUNT(*) FROM disasters),
            'active', (SELECT COUNT(*) FROM disasters WHERE is_active = true),
            'high_priority', (SELECT COUNT(*) FROM disasters WHERE priority_level >= 4),
            'created_today', (SELECT COUNT(*) FROM disasters WHERE DATE(created_at) = CURRENT_DATE)
        ),
        'resources', json_build_object(
            'total', (SELECT COUNT(*) FROM resources),
            'available', (SELECT COUNT(*) FROM resources WHERE is_available = true),
            'shelters', (SELECT COUNT(*) FROM resources WHERE type = 'shelter'),
            'medical', (SELECT COUNT(*) FROM resources WHERE type = 'medical')
        ),
        'reports', json_build_object(
            'total', (SELECT COUNT(*) FROM reports),
            'verified', (SELECT COUNT(*) FROM reports WHERE verification_status = 'verified'),
            'pending', (SELECT COUNT(*) FROM reports WHERE verification_status = 'pending'),
            'with_images', (SELECT COUNT(*) FROM reports WHERE image_url IS NOT NULL)
        ),
        'social_media', json_build_object(
            'total_posts', (SELECT COUNT(*) FROM social_media_posts),
            'urgent_posts', (SELECT COUNT(*) FROM social_media_posts WHERE sentiment = 'urgent'),
            'posts_today', (SELECT COUNT(*) FROM social_media_posts WHERE DATE(processed_at) = CURRENT_DATE)
        ),
        'official_updates', json_build_object(
            'total', (SELECT COUNT(*) FROM official_updates),
            'priority_updates', (SELECT COUNT(*) FROM official_updates WHERE priority_level >= 4),
            'updates_today', (SELECT COUNT(*) FROM official_updates WHERE DATE(fetched_at) = CURRENT_DATE)
        ),
        'system', json_build_object(
            'cache_entries', (SELECT COUNT(*) FROM cache),
            'expired_cache', (SELECT COUNT(*) FROM cache WHERE expires_at < NOW()),
            'database_size', pg_size_pretty(pg_database_size(current_database())),
            'last_updated', NOW()
        )
    ) INTO stats;
    
    RETURN stats;
END;
$$ language 'plpgsql';

-- Grant execute permissions to the appropriate roles
-- Note: Adjust these based on your Supabase RLS setup
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon;