const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const fs = require('fs');
const db = require('./database');
const cron = require('node-cron');
require('dotenv').config();

const app = express();

// Allowed file types for server-side validation
const allowedFileTypes = ['image/jpeg', 'image/png', 'application/pdf'];

const upload = multer({
    dest: 'uploads/',
    limits: {
        fileSize: 10 * 1024 * 1024,
        files: 9,
    }, // 10MB + 9 files
    fileFilter: (req, file, cb) => {
        if (allowedFileTypes.includes(file.mimetype)) {
            cb(null, true); // Accept file
        } else {
            cb(new Error('Invalid file type: ${file.mimetype}. Only JPEG, PNG, and PDF files are allowed.'));
        }
    },
});
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
            return res.status(404).send('<h1>Invalid or expired link.</h1>');
        }

        const row = rows[0];

        if (row.status === 'Completed') {
            res.send(`
                <h1>Upload Completed</h1>
                <p>Your upload has been completed successfully.</p>
                <form method="POST" action="/request-restart">
                    <input type="hidden" name="id" value="${id}">
                    <button type="submit">Request Restart</button>
                </form>
            `);
            return;
        }

        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Upload Your Files</title>
                <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha3/dist/css/bootstrap.min.css" rel="stylesheet">
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/croppie/2.6.5/croppie.min.css" />
                <style>
                    .spinner {
                        display: none;
                        width: 3rem;
                        height: 3rem;
                        border: 5px solid rgba(0, 0, 0, 0.1);
                        border-left-color: #007bff;
                        border-radius: 50%;
                        animation: spin 1s linear infinite;
                        margin: 20px auto;
                    }
                    @keyframes spin {
                        100% {
                            transform: rotate(360deg);
                        }
                    }
                </style>
            </head>
            <body>
                <div class="container mt-5">
                    <h1>Upload Files</h1>
                    <form id="uploadForm" method="POST" action="/upload" enctype="multipart/form-data">
                        <input type="hidden" name="id" value="${id}">
                        <div class="mb-3">
                            <label for="files" class="form-label">Select Files:</label>
                            <input type="file" id="files" name="files" class="form-control" multiple required>
                        </div>
                        <div id="preview" class="mb-3 d-flex flex-wrap gap-2"></div>
                        <div class="text-center">
                            <button id="uploadBtn" class="btn btn-primary">Upload</button>
                            <div id="loadingSpinner" class="spinner"></div>
                        </div>
                    </form>
                </div>

                <!-- Success Modal -->
                <div id="successModal" class="modal" tabindex="-1">
                    <div class="modal-dialog">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title">Upload Successful!</h5>
                                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                            </div>
                            <div class="modal-body">
                                <p>Your files have been uploaded successfully.</p>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Cropping Modal -->
                <div id="cropModal" class="modal" tabindex="-1">
                    <div class="modal-dialog">
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title">Crop Image</h5>
                                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                            </div>
                            <div class="modal-body">
                                <div id="croppieContainer"></div>
                            </div>
                            <div class="modal-footer">
                                <button id="saveCrop" class="btn btn-success">Save Crop</button>
                            </div>
                        </div>
                    </div>
                </div>

                <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha3/dist/js/bootstrap.bundle.min.js"></script>
                <script src="https://cdnjs.cloudflare.com/ajax/libs/croppie/2.6.5/croppie.min.js"></script>
                <script>
                    console.log("✅ Script loaded and running!");

                    const fileInput = document.getElementById('files');
                    const previewContainer = document.getElementById('preview');
                    const croppieContainer = document.getElementById('croppieContainer');
                    const modal = new bootstrap.Modal(document.getElementById('cropModal'));
                    const uploadBtn = document.getElementById('uploadBtn');
                    const loadingSpinner = document.getElementById('loadingSpinner');

                    let croppieInstance = null;
                    let filesMap = new Map();
                    let croppedFiles = new Map();

                    fileInput.addEventListener('change', handleFileSelect);

                    function handleFileSelect(event) {
                        previewContainer.innerHTML = '';
                        filesMap.clear();
                        croppedFiles.clear();

                        const filesArray = Array.from(event.target.files);
                        filesArray.forEach(file => {
                            const fileId = file.name + '-' + file.size + '-' + file.lastModified;
                            filesMap.set(fileId, file);
                            displayFilePreview(file, fileId);
                        });
                    }

                    function displayFilePreview(file, fileId) {
                        if (file.type.startsWith('image/')) {
                            const reader = new FileReader();
                            reader.onload = () => {
                                const imageWrapper = document.createElement('div');
                                imageWrapper.className = 'image-wrapper';
                                imageWrapper.dataset.fileId = fileId;

                                const image = document.createElement('img');
                                image.src = reader.result;
                                image.className = 'img-thumbnail';
                                image.style.width = '150px';
                                image.style.cursor = 'pointer';
                                image.addEventListener('click', () => openCropModal(reader.result, fileId));

                                imageWrapper.appendChild(image);
                                previewContainer.appendChild(imageWrapper);
                            };
                            reader.readAsDataURL(file);
                        }
                    }

                    function openCropModal(imageSrc, fileId) {
                        if (croppieInstance) croppieInstance.destroy();
                        croppieContainer.innerHTML = '';

                        croppieInstance = new Croppie(croppieContainer, {
                            viewport: { width: 200, height: 200, type: 'square' },
                            boundary: { width: 300, height: 300 }
                        });

                        croppieInstance.bind({ url: imageSrc });
                        modal.show();

                        document.getElementById('saveCrop').onclick = () => {
                            croppieInstance.result({ type: 'blob' }).then(croppedBlob => {
                                croppedFiles.set(fileId, croppedBlob);
                                updateThumbnail(fileId, croppedBlob);
                                modal.hide();
                            });
                        };
                    }

                    function updateThumbnail(fileId, croppedBlob) {
                        const reader = new FileReader();
                        reader.onload = () => {
                            const imageWrappers = previewContainer.querySelectorAll('.image-wrapper');
                            imageWrappers.forEach(wrapper => {
                                if (wrapper.dataset.fileId === fileId) {
                                    wrapper.querySelector('img').src = reader.result;
                                }
                            });
                        };
                        reader.readAsDataURL(croppedBlob);
                    }

                    document.getElementById('uploadForm').addEventListener('submit', async (event) => {
                        event.preventDefault();
                        uploadBtn.disabled = true;
                        loadingSpinner.style.display = 'block';

                        const formData = new FormData();
                        const id = document.querySelector('input[name="id"]').value;
                        formData.append('id', id);

                        filesMap.forEach((file, fileId) => {
                            if (croppedFiles.has(fileId)) {
                                formData.append('files', croppedFiles.get(fileId), file.name);
                            } else {
                                formData.append('files', file);
                            }
                        });

                        try {
                            const response = await fetch('/upload', { method: 'POST', body: formData });
                            const result = await response.json();
                            if (result.success) {
                                const successModal = new bootstrap.Modal(document.getElementById('successModal'));
                                successModal.show();
                                setTimeout(() => { window.location.reload(); }, 3000);
                            }
                        } finally {
                            loadingSpinner.style.display = 'none';
                            uploadBtn.disabled = false;
                        }
                    });
                </script>
            </body>
            </html>
        `);
    } catch (err) {
        console.error('Error:', err.message);
        res.status(500).send('<h1>An error occurred</h1>');
    }
});


// `/request-restart` Endpoint
app.post('/request-restart', async (req, res) => {
    const { id } = req.body;
    try {
        // Query the database for the request ID
        const rows = await db.query(`SELECT * FROM requests WHERE id = $1`, [id]);
        if (!rows || rows.length === 0) {
            return res.status(404).send('Invalid or expired link.');
        }

        const request = rows[0];

        // Update the status to 'Completed-Reset-Requested' in the database
        await db.query(`UPDATE requests SET status = $1 WHERE id = $2`, ['Completed-Reset-Requested', id]);

        // Send the reset email to the seller
        await sendResetEmail(process.env.PERSONAL_EMAIL, id);

        // Display confirmation message
        res.send(`
            <h1>Reset Request Sent</h1>
            <p>Your reset request has been sent and is under review by the seller.</p>
            <p>If you have further questions, please contact the seller at <a href="mailto:${process.env.PERSONAL_EMAIL}">${process.env.PERSONAL_EMAIL}</a>.</p>
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
            if (err.code === 'LIMIT_FILE_COUNT') {
                return res.status(400).send({ success: false, error: 'You can only upload up to 9 files.' });
            }
            if (err.message) {
                return res.status(400).send({ success: false, error: err.message });
            }
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

        await db.query(
            `UPDATE requests SET status = $1, timestamp = $2 WHERE id = $3`,
            ['Completed', centralTimestamp, id]
        );

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

// Schedule task to revert statuses every day at midnight
cron.schedule('0 0 * * *', async () => {
    console.log('Running scheduled task to revert reset requests.');
    try {
        const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
        const result = await db.query(
            `UPDATE requests 
             SET status = 'Completed' 
             WHERE status = 'Completed-Reset-Requested' AND timestamp < $1`,
            [fiveDaysAgo]
        );
        console.log(`Reverted ${result.rowCount} requests to 'Completed' status.`);
    } catch (err) {
        console.error('Error in scheduled task:', err.message);
    }
});


// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});