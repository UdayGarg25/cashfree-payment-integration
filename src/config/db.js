const { Pool } = require('pg');
require('dotenv').config();

const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT, 10) || 5432,
      database: process.env.DB_NAME || 'ums_payment_db',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err.message);
});

/**
 * Health check helper function to verify database connectivity.
 * @returns {Promise<{ ok: boolean, timestamp?: string, error?: string }>}
 */
const checkDbConnection = async () => {
  try {
    const res = await pool.query('SELECT NOW() as current_time');
    return {
      ok: true,
      timestamp: res.rows[0].current_time,
    };
  } catch (error) {
    const errorDetails = error.message || (error.errors && error.errors.map(e => e.message).join('; ')) || error.code || String(error);
    return {
      ok: false,
      error: errorDetails,
    };
  }
};

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  checkDbConnection,
};

