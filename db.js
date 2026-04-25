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
            calendar_id VARCHAR(255),
            message_id INTEGER NOT NULL,
            current_title TEXT NOT NULL,
            event_date TEXT,
            color_id TEXT,
            history JSONB DEFAULT '[]'::jsonb,
            creator_email TEXT DEFAULT 'невідомо',
            event_link TEXT DEFAULT ''
        );
    `);
    
    await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS calendar_id VARCHAR(255);`);
    await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS event_end_time TIMESTAMP;`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS subscriptions (
            calendar_id VARCHAR(255) PRIMARY KEY,
            chat_id BIGINT NOT NULL,
            added_by BIGINT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS thread_id BIGINT;`);
    await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS days_limit INTEGER DEFAULT 0;`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS whitelist (
            calendar_id VARCHAR(255),
            email VARCHAR(255),
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (calendar_id, email)
        );
    `);
}

module.exports = { pool, initDB };