const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const db = require('./database');
require('dotenv').config();

const app = express();
const upload = multer({ dest: 'uploads/' });
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const port = process.env.PORT || 3000;

// Google Drive Authentication
const auth = new google.auth.GoogleAuth({
    credentials: {
        client_email: process.env.CLIENT_EMAIL,
        private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'), // Handle newlines properly
    },
    scopes: ['https://www.googleapis.com/auth/drive'],
});

const drive = google.drive({ version: 'v3', auth });

// Helper function: Create folder in Google Drive
async function createFolder(folderName) {
    const fileMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
    };

    try {
        const res = await drive.files.create({
            resource: fileMetadata,
            fields: 'id',
        });
        console.log(`Folder "${folderName}" created with ID: ${res.data.id}`);
        return res.data.id;
    } catch (error) {
        console.error(`Error creating folder: ${error.message}`);
        throw new Error('Failed to create folder in Google Drive.');
    }
}

// Helper function: Upload file to Google Drive
async function uploadFile(filePath, fileName, folderId) {
    const fileMetadata = {
        name: fileName,
        parents: [folderId],
    };

    const media = {
        mimeType: 'application/octet-stream',
        body: fs.createReadStream(filePath),
    };

    try {
        const res = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id',
        });
        console.log(`File "${fileName}" uploaded with ID: ${res.data.id}`);
        return res.data.id;
    } catch (error) {
        console.error(`Error uploading file: ${error.message}`);
        throw new Error('Failed to upload file to Google Drive.');
    }
}

// Helper function: Share folder with your personal email
async function shareFolder(folderId, email) {
    try {
        await drive.permissions.create({
            fileId: folderId,
            requestBody: {
                role: 'writer',
                type: 'user',
                emailAddress: email, // Only your personal email
            },
        });
        console.log(`Folder shared with ${email}`);
    } catch (error) {
        console.error(`Error sharing folder: ${error.message}`);
        throw new Error('Failed to share folder.');
    }
}

// `/process-order` Endpoint
app.post('/process-order', async (req, res) => {
    try {
        const { name, email, receiptId, timestamp } = req.body;

        if (!name || !email || !receiptId) {
            console.error('Missing required fields:', { name, email, receiptId });
            return res.status(400).send({ success: false, error: 'Missing required fields.' });
        }

        console.log('Received order:', { name, email, receiptId, timestamp });

        // Generate unique ID for the upload form
        const uniqueId = crypto.randomUUID();

        // Save order to database
        db.run(
            `INSERT INTO requests (id, name, email, receiptId, timestamp, status) VALUES (?, ?, ?, ?, ?, ?)`,
            [uniqueId, name, email, receiptId, timestamp || new Date().toISOString(), 'Pending'],
            (err) => {
                if (err) {
                    console.error('Database Error:', err.message);
                    return res.status(500).send({ success: false, error: 'Failed to save record.' });
                }
                console.log(`Order saved for ${name} with ID ${uniqueId}`);
            }
        );

        // Generate upload link
        const uploadLink = `https://file-request-app.onrender.com/upload-form/${uniqueId}`;

        res.status(200).send({
            success: true,
            message: 'Order processed successfully.',
            uploadLink,
        });
    } catch (error) {
        console.error(`Error processing order: ${error.message}`);
        res.status(500).send({ success: false, error: error.message });
    }
});

// `/upload` Endpoint
app.post('/upload', (req, res, next) => {
    upload.array('files', 10)(req, res, (err) => {
        if (err) {
            console.error('Multer Error:', err);
            return res.status(500).send({ success: false, error: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        const { id } = req.body;

        db.get(`SELECT * FROM requests WHERE id = ?`, [id], async (err, row) => {
            if (err) {
                console.error('Database Error:', err.message);
                return res.status(500).send({ success: false, error: 'Database error occurred.' });
            }

            if (!row) {
                console.error('Invalid or expired link.');
                return res.status(404).send({ success: false, error: 'Invalid or expired link.' });
            }

            console.log(`Validated ID ${id} for ${row.name}`);

            const folderName = `Order-${row.receiptId}-${row.name}`;
            const folderId = await createFolder(folderName);

            // Share folder with your personal email
            const personalEmail = process.env.PERSONAL_EMAIL;
            await shareFolder(folderId, personalEmail);

            const uploadedFiles = [];
            for (const file of req.files) {
                const fileId = await uploadFile(file.path, file.originalname, folderId);
                uploadedFiles.push({ fileName: file.originalname, fileId });
                fs.unlinkSync(file.path); // Clean up local files
            }

            db.run(`UPDATE requests SET status = ? WHERE id = ?`, ['Completed', id], (err) => {
                if (err) {
                    console.error('Database Update Error:', err.message);
                } else {
                    console.log(`Request ${id} marked as completed.`);
                }
            });

            res.status(200).send({
                success: true,
                message: 'Files uploaded successfully.',
                files: uploadedFiles,
            });
        });
    } catch (error) {
        console.error(`Error processing upload: ${error.message}`);
        res.status(500).send({ success: false, error: error.message });
    }
});

// `/upload-form/:id` Endpoint
app.get('/upload-form/:id', (req, res) => {
    const { id } = req.params;

    db.get(`SELECT * FROM requests WHERE id = ?`, [id], (err, row) => {
        if (err) {
            console.error('Database Error:', err.message);
            return res.status(500).send('An error occurred.');
        }

        if (!row) {
            return res.status(404).send('Invalid or expired link.');
        }

        // Dynamically render the form
        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Upload Your Files</title>
            </head>
            <body>
                <h1>Upload Your Files</h1>
                <form action="/upload" method="POST" enctype="multipart/form-data">
                    <input type="hidden" name="id" value="${id}">
                    <label for="files">Select Files:</label>
                    <input type="file" name="files" multiple required><br><br>
                    <button type="submit">Upload</button>
                </form>
            </body>
            </html>
        `);
    });
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});