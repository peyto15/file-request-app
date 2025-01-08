const { Pool } = require('pg');
require('dotenv').config();

// Create a new PostgreSQL connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // Your PostgreSQL connection string
    ssl: {
        rejectUnauthorized: false, // Use this if your provider requires SSL (e.g., Heroku)
    },
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

// Initialize the database
const init = async () => {
    try {
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
        console.log('Database initialized.');
    } catch (err) {
        console.error('Error initializing database:', err.stack);
    }
};

// Call the init function to create the table if not exists
init();

module.exports = { query };