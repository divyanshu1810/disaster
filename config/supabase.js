const { createClient } = require('@supabase/supabase-js');
const logger = require('../utils/logger');

// Validate required environment variables
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  logger.error('Missing required Supabase environment variables', {
    missing: missingVars
  });
  process.exit(1);
}

// Create Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession: false, // We're using mock auth
    },
    db: {
      schema: 'public'
    }
  }
);

// Service role client for admin operations
const supabaseAdmin = process.env.SUPABASE_SERVICE_KEY 
  ? createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      {
        auth: {
          persistSession: false,
        }
      }
    )
  : null;

/**
 * Test database connection
 */
const testConnection = async () => {
  try {
    const { data, error } = await supabase
      .from('disasters')
      .select('count')
      .limit(1);

    if (error) {
      logger.error('Supabase connection test failed', { error: error.message });
      return false;
    }

    logger.info('Supabase connection successful');
    return true;
  } catch (err) {
    logger.error('Supabase connection error', { error: err.message });
    return false;
  }
};

/**
 * Helper function to handle Supabase responses
 */
const handleSupabaseResponse = (response, operation = 'operation') => {
  const { data, error } = response;
  
  if (error) {
    logger.error(`Supabase ${operation} failed`, {
      error: error.message,
      details: error.details,
      hint: error.hint
    });
    throw new Error(`Database ${operation} failed: ${error.message}`);
  }

  return data;
};

/**
 * Execute raw SQL query (requires service role)
 */
const executeSQL = async (query, params = []) => {
  if (!supabaseAdmin) {
    throw new Error('Service role key required for SQL execution');
  }

  try {
    const { data, error } = await supabaseAdmin.rpc('execute_sql', {
      query_text: query,
      query_params: params
    });

    return handleSupabaseResponse({ data, error }, 'SQL execution');
  } catch (err) {
    logger.error('SQL execution failed', {
      query: query.substring(0, 100) + '...',
      error: err.message
    });
    throw err;
  }
};

// Initialize connection test
testConnection().then(success => {
  if (!success) {
    logger.warn('Initial Supabase connection test failed - check configuration');
  }
});

module.exports = {
  supabase,
  supabaseAdmin,
  testConnection,
  handleSupabaseResponse,
  executeSQL
};