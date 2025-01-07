const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const OAuth = require('oauth-1.0a');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
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
        private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'), // Ensure line breaks are handled properly
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

// Helper function: Share folder with a user
async function shareFolder(folderId, email) {
    try {
        const res = await drive.permissions.create({
            fileId: folderId,
            requestBody: {
                role: 'writer',
                type: 'user',
                emailAddress: email,
            },
        });
        console.log(`Folder shared with ${email}`);
    } catch (error) {
        console.error(`Error sharing folder: ${error.message}`);
        throw new Error('Failed to share folder.');
    }
}


// Multiple file upload endpoint
app.post('/upload', (req, res, next) => {
    upload.array('files', 10)(req, res, (err) => {
        if (err) {
            console.error('Multer Error:', err);
            return res.status(500).send({ success: false, error: err.message });
        }
        next();
    });
}, async (req, res) => {
    console.log('Files:', req.files);
    console.log('Body:', req.body);

    try {
        const { name, email, receiptId } = req.body;

        // Validate request fields
        if (!name || !email || !receiptId) {
            console.error('Missing required fields:', { name, email, receiptId });
            return res.status(400).send({
                success: false,
                error: 'Missing required fields: name, email, or receiptId',
            });
        }

        if (!req.files || req.files.length === 0) {
            console.error('No files provided.');
            return res.status(400).send({
                success: false,
                error: 'No files provided in the request.',
            });
        }

        // Create folder or find existing one
        const folderName = `${name}-${email}`;
        const folderId = await createFolder(folderName);

        // Share the folder with your personal email
        const personalEmail = process.env.PERSONAL_EMAIL; // Replace with your personal email
        await shareFolder(folderId, personalEmail);

        // Upload all files to the folder
        const uploadedFiles = [];
        for (const file of req.files) {
            const fileId = await uploadFile(file.path, file.originalname, folderId);
            uploadedFiles.push({ fileName: file.originalname, fileId });

            // Cleanup local file
            fs.unlinkSync(file.path);
        }

        // Respond with success
        res.status(200).send({
            success: true,
            message: 'Files uploaded and folder shared successfully',
            files: uploadedFiles,
        });
    } catch (error) {
        console.error(`Error processing request: ${error.message}`);
        res.status(500).send({
            success: false,
            error: error.message,
        });
    }
});

app.post('/process-order', async (req, res) => {
    try {
        const { name, email, receiptId, timestamp, files } = req.body;

        // Validate incoming data
        if (!name || !email || !receiptId) {
            console.error('Missing required fields:', { name, email, receiptId });
            return res.status(400).send({ success: false, error: 'Missing required fields.' });
        }

        // Log the receipt data for debugging
        console.log('Received order:', { name, email, receiptId, timestamp, files });

        // Create a Google Drive folder for the buyer
        const folderName = `Order-${receiptId}-${name}`;
        const folderId = await createFolder(folderName);

        // Share the folder with the buyer's email
        await shareFolder(folderId, email);

        // Upload any files provided to the folder
        const uploadedFiles = [];
        if (files && Array.isArray(files)) {
            for (const file of files) {
                const { url, name: fileName } = file;

                // Download the file locally
                const filePath = `./uploads/${fileName}`;
                const response = await axios({
                    url,
                    method: 'GET',
                    responseType: 'stream',
                });
                const writer = fs.createWriteStream(filePath);
                response.data.pipe(writer);

                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                // Upload to Google Drive
                const fileId = await uploadFile(filePath, fileName, folderId);
                uploadedFiles.push({ fileName, fileId });

                // Clean up local file
                fs.unlinkSync(filePath);
            }
        }

        // Respond to Make with success
        res.status(200).send({
            success: true,
            message: 'Order processed successfully.',
            folderId,
            uploadedFiles,
        });
    } catch (error) {
        console.error(`Error processing order: ${error.message}`);
        res.status(500).send({ success: false, error: error.message });
    }
});

// Start server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});