const { Pool } = require('pg');
require('dotenv').config();

// Create a new PostgreSQL connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // Your PostgreSQL connection string
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false, // Conditional SSL based on environment
});

// Helper function to query the database
const query = async (text, params) => {
    try {
        const res = await pool.query(text, params);
        return res.rows;
    } catch (err) {
        console.error('Database query error:', err.stack);
        throw err;
    }
};

// Initialize the database schema
const init = async () => {
    try {
        console.log('Initializing database...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS requests (
                id UUID PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL,
                receiptId TEXT NOT NULL,
                timestamp TIMESTAMP NOT NULL,
                status TEXT DEFAULT 'Pending'
            );
        `);
        console.log('Database initialized successfully.');
    } catch (err) {
        console.error('Error initializing database:', err.stack);
        throw err;
    }
};

// Call the init function to create the table if it doesn't exist
init().catch((err) => {
    console.error('Fatal error during database initialization:', err.stack);
    process.exit(1); // Exit if the database initialization fails
});

module.exports = {
    query,
    pool, // Exposing the pool for direct usage if needed
};