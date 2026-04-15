const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false }
});

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS events (
            id SERIAL PRIMARY KEY,
            google_event_id VARCHAR(255) UNIQUE NOT NULL,
            message_id INTEGER NOT NULL,
            current_title TEXT NOT NULL,
            event_date TEXT,
            color_id TEXT,
            history JSONB DEFAULT '[]'::jsonb
        );
    `);
}

module.exports = { pool, initDB };