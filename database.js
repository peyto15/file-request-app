const sqlite3 = require('sqlite3').verbose();

// Initialize the database
const db = new sqlite3.Database('./file_request.db', (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log('Connected to SQLite database.');
    }
});

// Create the table for storing records
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS requests (
            id TEXT PRIMARY KEY,
            name TEXT,
            email TEXT,
            receiptId TEXT,
            timestamp TEXT,
            status TEXT DEFAULT 'Pending'
        )
    `, (err) => {
        if (err) {
            console.error('Error creating table:', err.message);
        } else {
            console.log('Requests table ready.');
        }
    });
});

module.exports = db;