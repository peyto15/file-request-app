const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const fs = require('fs');
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
        private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/drive'],
});

const drive = google.drive({ version: 'v3', auth });

// Nodemailer setup for sending emails
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.PERSONAL_EMAIL,
        pass: process.env.EMAIL_PASSWORD,
    },
});

// Helper: Find existing folder in Google Drive
async function findFolder(folderName) {
    try {
        const res = await drive.files.list({
            q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder'`,
            fields: 'files(id, name)',
        });

        if (res.data.files.length > 0) {
            console.log(`Found folder "${folderName}" with ID: ${res.data.files[0].id}`);
            return res.data.files[0].id;
        }

        return null;
    } catch (error) {
        console.error(`Error finding folder: ${error.message}`);
        throw new Error('Failed to find folder in Google Drive.');
    }
}

// Helper: Create folder in Google Drive
async function createFolder(folderName) {
    try {
        const folderId = await findFolder(folderName);
        if (folderId) return folderId;

        const res = await drive.files.create({
            resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
            fields: 'id',
        });
        console.log(`Folder "${folderName}" created with ID: ${res.data.id}`);
        return res.data.id;
    } catch (error) {
        console.error(`Error creating folder: ${error.message}`);
        throw new Error('Failed to create folder in Google Drive.');
    }
}

// Helper: Upload file to Google Drive
async function uploadFile(filePath, fileName, folderId) {
    try {
        const res = await drive.files.create({
            resource: { name: fileName, parents: [folderId] },
            media: { mimeType: 'application/octet-stream', body: fs.createReadStream(filePath) },
            fields: 'id',
        });
        console.log(`File "${fileName}" uploaded with ID: ${res.data.id}`);
        return res.data.id;
    } catch (error) {
        console.error(`Error uploading file: ${error.message}`);
        throw new Error('Failed to upload file to Google Drive.');
    }
}

// Helper: Share folder
async function shareFolder(folderId, email) {
    try {
        await drive.permissions.create({
            fileId: folderId,
            requestBody: { role: 'writer', type: 'user', emailAddress: email },
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
            return res.status(400).send({ success: false, error: 'Missing required fields.' });
        }

        const uniqueId = crypto.randomUUID();
        const createdAt = timestamp || new Date().toISOString();

        await db.query(
            `INSERT INTO requests (id, name, email, receiptId, timestamp, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [uniqueId, name, email, receiptId, createdAt, 'Pending']
        );

        const uploadLink = `https://file-request-app.onrender.com/upload-form/${uniqueId}`;
        res.status(200).send({ success: true, message: 'Order processed successfully.', uploadLink });
    } catch (error) {
        console.error(`Error processing order: ${error.message}`);
        res.status(500).send({ success: false, error: error.message });
    }
});

// `/upload-form/:id` Endpoint
app.get('/upload-form/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const rows = await db.query(`SELECT * FROM requests WHERE id = $1`, [id]);
        if (!rows || rows.length === 0) {
            return res.status(404).send('Invalid or expired link.');
        }

        const row = rows[0];
        if (row.status === 'Completed') {
            res.send(`
                <h1>Upload Already Completed</h1>
                <p>Your upload has been successfully completed.</p>
                <form action="/request-restart" method="POST">
                    <input type="hidden" name="id" value="${id}">
                    <button type="submit">Request Restart</button>
                </form>
            `);
        } else {
            res.send(`
                <h1>Upload Your Files</h1>
                <form action="/upload" method="POST" enctype="multipart/form-data">
                    <input type="hidden" name="id" value="${id}">
                    <label for="files">Select Files:</label>
                    <input type="file" name="files" multiple required><br><br>
                    <button type="submit">Upload</button>
                </form>
            `);
        }
    } catch (err) {
        console.error('Database Error:', err.stack);
        res.status(500).send('An error occurred.');
    }
});

// `/request-restart` Endpoint
app.post('/request-restart', async (req, res) => {
    const { id } = req.body;
    try {
        const rows = await db.query(`SELECT * FROM requests WHERE id = $1`, [id]);
        if (!rows || rows.length === 0) {
            return res.status(404).send('Invalid or expired link.');
        }

        const request = rows[0];
        await sendResetEmail(process.env.PERSONAL_EMAIL, id);

        res.send(`
            <h1>Restart Request Sent</h1>
            <p>Your restart request has been sent. Please wait for confirmation.</p>
        `);
    } catch (err) {
        console.error('Error processing restart request:', err.message);
        res.status(500).send('An error occurred while processing your request.');
    }
});

// `/upload` Endpoint
app.post('/upload', (req, res, next) => {
    upload.array('files', 10)(req, res, (err) => {
        if (err) {
            return res.status(500).send({ success: false, error: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        const { id } = req.body;
        const rows = await db.query(`SELECT * FROM requests WHERE id = $1`, [id]);
        if (!rows || rows.length === 0) {
            return res.status(404).send({ success: false, error: 'Invalid or expired link.' });
        }

        const request = rows[0];
        const folderName = `Order-${request.receiptid}-${request.name}`;
        const folderId = await createFolder(folderName);

        await shareFolder(folderId, process.env.PERSONAL_EMAIL);

        const uploadedFiles = [];
        for (const file of req.files) {
            const fileId = await uploadFile(file.path, file.originalname, folderId);
            uploadedFiles.push({ fileName: file.originalname, fileId });
            fs.unlinkSync(file.path);
        }

        const centralTimestamp = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Chicago',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            hour12: true,
        }).format(new Date());

        await db.query(`UPDATE requests SET status = $1, timestamp = $2 WHERE id = $3`, ['Completed', centralTimestamp, id]);

        res.status(200).send({
            success: true,
            message: 'Files uploaded successfully.',
            files: uploadedFiles,
        });
    } catch (error) {
        console.error(`Error processing upload: ${error.message}`);
        res.status(500).send({ success: false, error: error.message });
    }
});

// Helper: Send Reset Email
const sendResetEmail = async (recipientEmail, id) => {
    const resetLink = `https://file-request-app.onrender.com/reset-upload/${id}`;

    const mailOptions = {
        from: `"File Request App" <${process.env.PERSONAL_EMAIL}>`,
        to: `"Admin" <${process.env.PERSONAL_EMAIL}>`,
        subject: `Reset Upload for Order ID: ${id}`,
        html: `
            <h1>Reset Upload Request</h1>
            <p>A restart has been requested. Click the button below to reset the upload process:</p>
            <a href="${resetLink}" style="
                display: inline-block;
                padding: 12px 20px; 
                font-size: 16px; 
                color: #fff; 
                background-color: #007BFF; 
                text-decoration: none; 
                border-radius: 6px;
                text-align: center;
                border: 1px solid #007BFF;
                font-family: Arial, sans-serif;">Reset Upload</a>
        `,
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log('Reset email sent:', info.response);
    } catch (err) {
        console.error('Error sending reset email:', err.message);
    }
};

// `/reset-upload/:id` Endpoint
app.get('/reset-upload/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Fetch the request from the database
        const rows = await db.query(`SELECT * FROM requests WHERE id = $1`, [id]);
        if (!rows || rows.length === 0) {
            return res.status(404).send('Invalid or expired link.');
        }

        const request = rows[0];
        const folderName = `Order-${request.receiptid}-${request.name}`;
        const folderId = await findFolder(folderName);

        if (!folderId) {
            return res.status(404).send('Google Drive folder not found.');
        }

        // List and delete all files in the folder
        const listResponse = await drive.files.list({
            q: `'${folderId}' in parents`,
            fields: 'files(id, name)',
        });

        for (const file of listResponse.data.files) {
            await drive.files.delete({ fileId: file.id });
            console.log(`Deleted file: ${file.name}`);
        }

        // Reset the status to "Pending" in the database
        await db.query(`UPDATE requests SET status = $1 WHERE id = $2`, ['Pending', id]);

        res.send(`
            <h1>Upload Reset Successful</h1>
            <p>The upload process has been reset. The user can now re-upload their files.</p>
        `);
    } catch (err) {
        console.error('Error resetting upload:', err.message);
        res.status(500).send('An error occurred while resetting the upload process.');
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});