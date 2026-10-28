const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();
const { pool } = require('./db');

/**
 * Ensures the target application database exists before connecting with the main pool.
 * Connects to the default PostgreSQL maintenance database ('postgres') to check and create if needed.
 */
async function ensureDatabaseExists() {
  const targetDb = process.env.DB_NAME || 'ums_payment_db';

  let maintenanceConfig;
  if (process.env.DATABASE_URL) {
    const parsedUrl = new URL(process.env.DATABASE_URL);
    parsedUrl.pathname = '/postgres';
    maintenanceConfig = { connectionString: parsedUrl.toString() };
  } else {
    maintenanceConfig = {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT, 10) || 5432,
      database: 'postgres',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      connectionTimeoutMillis: 5000,
    };
  }

  const maintenanceClient = new Client(maintenanceConfig);

  try {
    await maintenanceClient.connect();

    const checkResult = await maintenanceClient.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [targetDb]
    );

    if (checkResult.rowCount === 0) {
      console.log(`Database "${targetDb}" does not exist. Creating database...`);

      // Ensure identifier safety
      if (!/^[a-zA-Z0-9_]+$/.test(targetDb)) {
        throw new Error(`Invalid characters in database name: ${targetDb}`);
      }

      await maintenanceClient.query(`CREATE DATABASE "${targetDb}"`);
      console.log(`Database "${targetDb}" created successfully.`);
    } else {
      console.log(`Database "${targetDb}" already exists.`);
    }
  } finally {
    try {
      await maintenanceClient.end();
      console.log('PostgreSQL maintenance connection closed.');
    } catch (closeErr) {
      console.error('Error closing maintenance connection:', closeErr.message);
    }
  }
}

/**
 * Executes the database schema script using the existing connection pool.
 */
async function setupDatabase() {
  console.log('Starting database setup...');
  const schemaPath = path.join(__dirname, 'schema.sql');

  let client;
  try {
    await ensureDatabaseExists();

    const schemaSql = fs.readFileSync(schemaPath, 'utf8');

    client = await pool.connect();
    console.log('Connected to target PostgreSQL database successfully.');

    await client.query('BEGIN');
    await client.query(schemaSql);
    await client.query('COMMIT');

    console.log('Database schema applied successfully.');
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Error during transaction rollback:', rollbackError.message || rollbackError);
      }
    }
    const errorDetails = error.message || (error.errors && error.errors.map(e => e.message).join('; ')) || error.code || String(error);
    console.error('Database setup failed:', errorDetails);
    process.exitCode = 1;
  } finally {
    if (client) {
      client.release();
    }
    try {
      await pool.end();
      console.log('Database pool closed.');
    } catch (poolCloseError) {
      console.error('Error closing database pool:', poolCloseError.message);
    }
  }
}

if (require.main === module) {
  setupDatabase();
}

module.exports = {
  setupDatabase,
  ensureDatabaseExists,
};
