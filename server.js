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


app.get('/upload-form/:id', async (req, res) => {
    const { id } = req.params;

    try {
        // Query the database for the specific ID
        const rows = await db.query(`SELECT * FROM requests WHERE id = $1`, [id]);

        if (!rows || rows.length === 0) {
            console.error('No matching ID found.');
            return res.status(404).send('Invalid or expired link.');
        }

        const row = rows[0];
        console.log(`Valid request found for ID ${id}:`, row);

        // Check the request status
        if (row.status === 'Completed') {
            res.send(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Upload Already Completed</title>
                    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha3/dist/css/bootstrap.min.css" rel="stylesheet">
                </head>
                <body class="text-center">
                    <div class="container mt-5">
                        <h1>Upload Already Completed</h1>
                        <p>Your upload has been successfully completed.</p>
                        <form action="/request-restart" method="POST">
                            <input type="hidden" name="id" value="${id}">
                            <button class="btn btn-warning" type="submit">Request Restart</button>
                        </form>
                    </div>
                </body>
                </html>
            `);
        } else if (row.status === 'Completed-Reset-Requested') {
            res.send(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Reset Request Under Review</title>
                    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha3/dist/css/bootstrap.min.css" rel="stylesheet">
                </head>
                <body class="text-center">
                    <div class="container mt-5">
                        <h1>Reset Request Under Review</h1>
                        <p>Your reset request has been sent and is under review by the seller.</p>
                        <p>If you have further questions, please contact the seller at <a href="mailto:${process.env.PERSONAL_EMAIL}">${process.env.PERSONAL_EMAIL}</a>.</p>
                    </div>
                </body>
                </html>
            `);
        } else {
            res.send(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Upload Your Files</title>
                    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha3/dist/css/bootstrap.min.css" rel="stylesheet">
                    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/cropperjs/2.0.0-alpha.3/cropper.min.css" />
                    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha3/dist/js/bootstrap.bundle.min.js"></script>
                    <script src="https://cdnjs.cloudflare.com/ajax/libs/cropperjs/2.0.0-alpha.3/cropper.min.js"></script>
                </head>
                <body>
                    <div class="container mt-5">
                        <h1 class="text-center">Upload Your Files</h1>
                        <form id="uploadForm" action="/upload" method="POST" enctype="multipart/form-data">
                            <input type="hidden" name="id" value="${id}">
                            <div class="mb-3">
                                <label for="files" class="form-label">Select or Drag Files:</label>
                                <div id="drop-zone" class="border border-primary p-3 text-center" style="cursor: pointer;">
                                    Drag and drop files here or click to select files
                                </div>
                                <input type="file" name="files" id="files" class="form-control d-none" multiple required>
                            </div>
                            <div id="file-list" class="mt-3"></div>
                            <button type="submit" class="btn btn-primary mt-3">Upload</button>
                        </form>
                    </div>

                    <!-- Modal for cropping -->
                    <div class="modal fade" id="cropModal" tabindex="-1" aria-labelledby="cropModalLabel" aria-hidden="true">
                        <div class="modal-dialog modal-lg">
                            <div class="modal-content">
                                <div class="modal-header">
                                    <h5 class="modal-title" id="cropModalLabel">Crop Your Image</h5>
                                    <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                                </div>
                                <div class="modal-body">
                                    <div id="crop-container">
                                        <img id="crop-image" src="#" alt="Crop Preview" style="max-width: 100%;">
                                    </div>
                                </div>
                                <div class="modal-footer">
                                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                                    <button type="button" id="save-crop" class="btn btn-success">Save Crop</button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <script>
                        const dropZone = document.getElementById('drop-zone');
                        const fileInput = document.getElementById('files');
                        const fileList = document.getElementById('file-list');
                        const allowedFileTypes = ['image/jpeg', 'image/png'];
                        const maxFileSize = 10 * 1024 * 1024; // 10MB
                        const cropModal = new bootstrap.Modal(document.getElementById('cropModal'));
                        const cropImage = document.getElementById('crop-image');
                        let cropper;

                        dropZone.addEventListener('click', () => fileInput.click());
                        dropZone.addEventListener('dragover', (event) => {
                            event.preventDefault();
                            dropZone.classList.add('bg-light');
                        });
                        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('bg-light'));
                        dropZone.addEventListener('drop', (event) => {
                            event.preventDefault();
                            dropZone.classList.remove('bg-light');
                            fileInput.files = event.dataTransfer.files;
                            displayFiles(fileInput.files);
                        });

                        fileInput.addEventListener('change', () => displayFiles(fileInput.files));

                        function displayFiles(files) {
                            fileList.innerHTML = '';
                            Array.from(files).forEach((file, index) => {
                                if (!allowedFileTypes.includes(file.type)) {
                                    alert(\`Invalid file type: \${file.name}\`);
                                    return;
                                }
                                if (file.size > maxFileSize) {
                                    alert(\`File too large: \${file.name}\`);
                                    return;
                                }
                                const row = document.createElement('div');
                                row.className = 'd-flex justify-content-between align-items-center mb-2';
                                row.innerHTML = \`
                                    <span><img src="\${URL.createObjectURL(file)}" style="width: 50px; height: 50px; object-fit: cover;" alt="Thumbnail" class="me-2"> \${file.name}</span>
                                    <div>
                                        <button type="button" class="btn btn-secondary btn-sm me-2" onclick="openCropModal(\${index})">Crop</button>
                                    </div>
                                \`;
                                fileList.appendChild(row);
                            });
                        }

                        function openCropModal(fileIndex) {
                            const file = fileInput.files[fileIndex];
                            const reader = new FileReader();
                            reader.onload = () => {
                                cropImage.src = reader.result;
                                cropper = new Cropper(cropImage, {
                                    aspectRatio: 1,
                                    viewMode: 2,
                                });
                                cropModal.show();
                            };
                            reader.readAsDataURL(file);
                        }

                        document.getElementById('save-crop').addEventListener('click', () => {
                            const croppedCanvas = cropper.getCroppedCanvas();
                            croppedCanvas.toBlob((blob) => {
                                console.log('Cropped image ready for upload.');
                                cropModal.hide();
                                cropper.destroy();
                            });
                        });
                    </script>
                </body>
                </html>
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