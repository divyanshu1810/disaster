const http = require('http');

const options = {
  hostname: 'localhost',
  port: process.env.PORT || 5000,
  path: '/health',
  timeout: 2000,
  method: 'GET'
};

const healthCheck = http.request(options, (res) => {
  console.log(`Health check status: ${res.statusCode}`);
  if (res.statusCode === 200) {
    process.exit(0);
  } else {
    process.exit(1);
  }
});

healthCheck.on('error', (error) => {
  console.error('Health check failed:', error);
  process.exit(1);
});

healthCheck.on('timeout', () => {
  console.error('Health check timeout');
  healthCheck.destroy();
  process.exit(1);
});

healthCheck.end();