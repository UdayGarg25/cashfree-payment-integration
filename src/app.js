require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { checkDbConnection } = require('./config/db');
const paymentRoutes = require('./routes/paymentRoutes');
const webhookRoutes = require('./routes/webhookRoutes');

const app = express();
const PORT = process.env.PORT || 5000;
const isProduction = (process.env.NODE_ENV || 'development') === 'production';

// Basic security & CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-webhook-signature', 'x-webhook-timestamp'],
}));

// Body parsing with 100kb limit & rawBody preservation for HMAC signature validation
app.use(
  express.json({
    limit: '100kb',
    verify: (req, res, buf) => {
      req.rawBody = buf ? buf.toString('utf8') : '';
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// API Routes
app.use('/api/payments', paymentRoutes);
app.use('/api/webhooks', webhookRoutes);

// Server Health Check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    service: 'UMS Cashfree Payment Integration Service',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Database Health Check
app.get('/health/db', async (req, res) => {
  const dbStatus = await checkDbConnection();
  if (dbStatus.ok) {
    return res.status(200).json({
      status: 'OK',
      database: 'Connected',
      serverTime: dbStatus.timestamp,
    });
  }

  return res.status(503).json({
    status: 'ERROR',
    database: 'Disconnected',
    error: isProduction ? 'Database service unavailable' : dbStatus.error,
  });
});

// Fallback 404 handler
app.use((req, res) => {
  res.status(404).json({
    status: 'FAIL',
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// Global error handler (prevents leaking internal stack traces)
app.use((err, req, res, next) => {
  if (!isProduction) {
    console.error('Unhandled Server Error:', err);
  }
  const statusCode = err.status || 500;
  const message = isProduction && statusCode === 500
    ? 'Internal Server Error'
    : (err.message || 'Internal Server Error');

  res.status(statusCode).json({
    status: 'ERROR',
    message,
    ...(err.code && { code: err.code }),
  });
});

// Start server if executed directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });
}

module.exports = app;
