const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const fs = require('fs');
const db = require('./database');
const bodyParser = require("body-parser");
const cron = require('node-cron');
require('dotenv').config();
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;


// ✅ 1️⃣ Shopify Webhook (Use `express.raw()` to capture raw body)
app.post("/shopify-webhook", express.raw({ type: "application/json" }), async (req, res) => {
    console.log("\n🛒 Shopify Webhook Received!");
    const hmac = req.get("X-Shopify-Hmac-Sha256");

    if (!hmac || !req.body || req.body.length === 0) {
        console.log("❌ Missing HMAC or rawBody");
        return res.status(400).send("Invalid request");
    }

    // Validate Signature
    const hash = crypto.createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET)
                       .update(req.body)
                       .digest("base64");

    if (hmac !== hash) {
        console.log("❌ Unauthorized - Invalid HMAC");
        return res.status(401).send("Unauthorized");
    }

    // ✅ Parse JSON Body
    const order = JSON.parse(req.body.toString());
    console.log("📦 Order Data:", order);

    // Extract Data
    const orderData = {
        id: crypto.randomUUID(), // Generate unique request ID
        name: `${order.customer?.first_name || "Unknown"} ${order.customer?.last_name || ""}`.trim(),
        email: order.contact_email || order.customer?.email || "No Email",
        receiptid: order.id,
        timestamp: order.created_at,
        status: "Pending",
    };

    // 🔍 Check for Duplicate Orders
    const existing = await db.query("SELECT * FROM requests WHERE receiptid = $1", [orderData.receiptid]);

    if (existing.rowCount > 0) {
        console.log("⚠️ Order already exists. Skipping duplicate entry.");
        return res.status(200).send("Order already processed.");
    }

    // 🚫 Ensure Email Exists
    if (!orderData.email || orderData.email === "No Email") {
        console.log("⚠️ No customer email found. Skipping order.");
        return res.status(400).send("Missing customer email.");
    }

    // 🔹 Save to Database
    try {
        await db.query(
            `INSERT INTO requests (id, name, email, receiptid, timestamp, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [orderData.id, orderData.name, orderData.email, orderData.receiptid, orderData.timestamp, orderData.status]
        );
        console.log("✅ Order Saved to Database:", orderData);
    } catch (error) {
        console.error("❌ Error saving order:", error);
        return res.status(500).send("Database Error");
    }

    // 🎯 **TRIGGER EMAIL AFTER SAVING ORDER**
    const uploadLink = `https://file-request-app.onrender.com/upload-form/${orderData.id}`;
    await sendUploadEmail(orderData.email, uploadLink);

    res.status(200).send("Order Processed Successfully.");
});

// ✅ 2️⃣ NOW Enable `express.json()` for ALL Other Routes
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

// Landing page bc why not
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Allowed file types for server-side validation
const allowedFileTypes = ['image/jpeg', 'image/png', 'application/pdf'];

const upload = multer({
    dest: 'uploads/',
    limits: {
        fileSize: 25 * 1024 * 1024,
        files: 18,
    }, // 10MB + 9 files
    fileFilter: (req, file, cb) => {
        if (allowedFileTypes.includes(file.mimetype)) {
            cb(null, true); // Accept file
        } else {
            cb(new Error('Invalid file type: ${file.mimetype}. Only JPEG, PNG, and PDF files are allowed.'));
        }
    },
});
// app.use(express.json());
// app.use(express.urlencoded({ extended: true }));


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

`/process-order`
app.post('/process-order', async (req, res) => {
    try {
        const { name, email, receiptid, timestamp } = req.body;
        if (!name || !email || !receiptid) {
            return res.status(400).send({ success: false, error: 'Missing required fields.' });
        }

        const uniqueId = crypto.randomUUID();
        const createdAt = timestamp || new Date().toISOString();

        await db.query(
            `INSERT INTO requests (id, name, email, receiptid, timestamp, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [uniqueId, name, email, receiptid, createdAt, 'Pending']
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
                <title>Upload & Crop Images</title>
                <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0-alpha3/dist/css/bootstrap.min.css" rel="stylesheet">
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/croppie/2.6.5/croppie.min.css" />
                <style>
                    body {
                        background-color: #f8f9fa;
                        font-family: Arial, sans-serif;
                    }

                    .container {
                        max-width: 900px;
                        margin: 50px auto;
                        background: white;
                        padding: 20px;
                        border-radius: 10px;
                        box-shadow: 0px 4px 10px rgba(0, 0, 0, 0.1);
                    }

                    /* Image Grid */
                    .image-grid {
                        display: grid;
                        grid-template-columns: repeat(3, 1fr);
                        gap: 15px;
                        padding: 15px;
                        background: #e9ecef; /* Light gray background */
                        border-radius: 10px;
                        justify-content: center;
                        margin-top: 10px;
                    }

                    .image-grid img {
                        width: 100%;
                        height: auto;
                        max-height: 150px;
                        object-fit: cover;
                        border-radius: 8px;
                        cursor: pointer;
                        transition: transform 0.2s ease-in-out;
                        border: 5px solid #fff;
                    }

                    .image-grid img:hover {
                        transform: scale(1.05);
                    }

                    /* Flexbox for Upload Section */
                    .upload-section {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                    }

                    /* Bouncy Spinner */
                    .spinner {
                        display: none;
                        width: 50px;
                        height: 50px;
                        border-radius: 50%;
                        background: linear-gradient(45deg, #007bff, #6610f2);
                        animation: bounce 1.2s infinite alternate ease-in-out;
                        margin: 20px auto;
                    }

                    @keyframes bounce {
                        0% { transform: translateY(0); }
                        100% { transform: translateY(-10px); }
                    }

                    .upload-overlay {
                        display: none;
                        position: fixed;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        background: rgba(0, 0, 0, 0.7);
                        z-index: 1000;
                        justify-content: center;
                        align-items: center;
                        text-align: center;
                    }

                    .spinner-container {
                        background: white;
                        padding: 30px;
                        border-radius: 15px;
                        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                    }

                    .magnet-spinner {
                        width: 60px;
                        height: 60px;
                        margin: 0 auto 20px;
                        animation: spin 2s linear infinite;
                    }

                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }

                    .loading-text {
                        color: #333;
                        font-size: 18px;
                        margin-top: 15px;
                        font-family: 'Arial', sans-serif;
                    }

                    .stars-spinner {
                        width: 100px;
                        height: 100px;
                        margin: 0 auto 20px;
                    }

                    .star-1 { animation: twinkle 1.5s infinite; }
                    .star-2 { animation: twinkle 1.5s infinite 0.5s; }
                    .star-3 { animation: twinkle 1.5s infinite 1s; }

                    @keyframes twinkle {
                        0% { transform: scale(1); opacity: 1; }
                        50% { transform: scale(0.8); opacity: 0.3; }
                        100% { transform: scale(1); opacity: 1; }
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1 class="text-center">Crop and Upload Images</h1>
                    <form id="uploadForm" method="POST" action="/upload" enctype="multipart/form-data">
                        <input type="hidden" name="id" value="${id}">
                        <div class="upload-section">
                            <input type="file" id="files" name="files" class="form-control" multiple required>
                            <button id="uploadBtn" class="btn btn-primary ms-2">Upload</button>
                        </div>
                        <div id="preview" class="image-grid"></div>
                        <div class="upload-overlay">
                            <div class="spinner-container">
                                <svg class="stars-spinner" viewBox="0 0 100 100" fill="none" stroke="#007bff">
                                    <!-- Main star -->
                                    <path class="star-1" d="M50 15 L53 35 L65 25 L55 40 L75 43 L55 45 L65 60 L50 47 L35 60 L45 45 L25 43 L45 40 L35 25 L47 35 Z" 
                                          fill="#007bff" stroke="none">
                                        <animate attributeName="opacity" from="1" to="0.3" dur="1.5s" repeatCount="indefinite"/>
                                    </path>
                                    <!-- Smaller stars -->
                                    <path class="star-2" d="M20 20 L22 25 L27 22 L24 27 L29 29 L24 30 L27 35 L20 31 L15 35 L18 30 L13 29 L18 27 L15 22 L19 25 Z" 
                                          fill="#4dabf7" stroke="none">
                                        <animate attributeName="opacity" from="1" to="0.3" dur="1.5s" begin="0.5s" repeatCount="indefinite"/>
                                    </path>
                                    <path class="star-3" d="M75 25 L77 30 L82 27 L79 32 L84 34 L79 35 L82 40 L75 36 L70 40 L73 35 L68 34 L73 32 L70 27 L74 30 Z" 
                                          fill="#4dabf7" stroke="none">
                                        <animate attributeName="opacity" from="1" to="0.3" dur="1.5s" begin="1s" repeatCount="indefinite"/>
                                    </path>
                                </svg>
                                <div class="loading-text">Your memories are on their way to magnetization! ✨</div>
                            </div>
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

                    const fileInput = document.getElementById("files");
                    const previewContainer = document.getElementById("preview");
                    const croppieContainer = document.getElementById("croppieContainer");
                    const modal = new bootstrap.Modal(document.getElementById("cropModal"));
                    const uploadBtn = document.getElementById("uploadBtn");

                    let croppieInstance = null;
                    let filesMap = new Map();
                    let croppedFiles = new Map();

                    fileInput.addEventListener("change", handleFileSelect);

                    function handleFileSelect(event) {
                        previewContainer.innerHTML = "";
                        filesMap.clear();
                        croppedFiles.clear();

                        const filesArray = Array.from(event.target.files);
                        filesArray.forEach(file => {
                            const fileId = file.name + '-' + file.size + '-' + file.lastModified;
                            filesMap.set(fileId, file);
                            displayFilePreview(file, fileId);
                        });

                        adjustGridLayout(filesArray.length);
                    }

                    function displayFilePreview(file, fileId) {
                        if (file.type.startsWith("image/")) {
                            const reader = new FileReader();
                            reader.onload = () => {
                                const imageWrapper = document.createElement("div");
                                imageWrapper.className = "image-wrapper";
                                imageWrapper.dataset.fileId = fileId;

                                const image = document.createElement("img");
                                image.src = reader.result;
                                image.className = "img-thumbnail";
                                image.style.cursor = "pointer";
                                image.addEventListener("click", () => openCropModal(reader.result, fileId));

                                imageWrapper.appendChild(image);
                                previewContainer.appendChild(imageWrapper);
                            };
                            reader.readAsDataURL(file);
                        }
                    }

                    function openCropModal(imageSrc, fileId) {
                        if (croppieInstance) croppieInstance.destroy();
                        croppieContainer.innerHTML = "";

                        croppieInstance = new Croppie(croppieContainer, {
                            viewport: { width: 300, height: 300, type: "square" },
                            boundary: { width: 400, height: 400 }
                        });

                        croppieInstance.bind({ url: imageSrc });
                        modal.show();

                        document.getElementById("saveCrop").onclick = () => {
                            croppieInstance.result({ type: "blob" }).then(croppedBlob => {
                                croppedFiles.set(fileId, croppedBlob);
                                updateThumbnail(fileId, croppedBlob);
                                modal.hide();
                            });
                        };
                    }

                    function updateThumbnail(fileId, croppedBlob) {
                        const reader = new FileReader();
                        reader.onload = () => {
                            const imageWrappers = previewContainer.querySelectorAll(".image-wrapper");
                            imageWrappers.forEach(wrapper => {
                                if (wrapper.dataset.fileId === fileId) {
                                    wrapper.querySelector("img").src = reader.result;
                                }
                            });
                        };
                        reader.readAsDataURL(croppedBlob);
                    }

                    function adjustGridLayout(imageCount) {
                        previewContainer.style.gridTemplateColumns = "repeat(3, 1fr)";
                    }

                    // Update the upload form script section:

                    document.getElementById("uploadForm").addEventListener("submit", async (event) => {
                        event.preventDefault();
                        
                        const overlay = document.querySelector('.upload-overlay');
                        uploadBtn.disabled = true;
                        overlay.style.display = "flex";
                        
                        const formData = new FormData();
                        const id = document.querySelector('input[name="id"]').value;
                        formData.append("id", id);

                        // Handle both cropped and uncropped files
                        for (const [fileId, file] of filesMap) {
                            if (croppedFiles.has(fileId)) {
                                const croppedBlob = croppedFiles.get(fileId);
                                const originalName = file.name;
                                const extension = originalName.split('.').pop();
                                const baseName = originalName.slice(0, -(extension.length + 1));
                                const newName = \`\${baseName}-cropped.\${extension}\`;
                                formData.append("files", croppedBlob, newName);
                            } else {
                                formData.append("files", file);
                            }
                        }

                        try {
                            const response = await fetch("/upload", {
                                method: "POST",
                                body: formData
                            });

                            if (response.ok) {
                                setTimeout(() => {
                                    window.location.reload();
                                }, 1000);
                            } else {
                                throw new Error('Upload failed');
                            }
                        } catch (error) {
                            console.error("🚨 Upload error:", error);
                            alert("Upload failed. " + error.message);
                            overlay.style.display = "none";
                        } finally {
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

const { unlink } = require('fs').promises;

app.post('/upload', upload.array('files', 18), async (req, res) => {
    try {
        console.log("📂 Upload request received!");
        console.log("📥 Files received:", req.files);
        console.log("🆔 Received ID:", req.body.id);

        const { id } = req.body;
        if (!id || id.length !== 36) {
            console.error("❌ Invalid request ID!", id);
            return res.status(400).json({ success: false, error: "Invalid request ID format!" });
        }

        // Query database with error handling
        const queryResult = await db.query(`
            SELECT id, "receiptid", name, email, status 
            FROM requests 
            WHERE id = $1 AND status = 'Pending'
        `, [id]);

        console.log("Query result:", queryResult);

        if (!queryResult || queryResult.length === 0) {
            console.error("❌ No valid request found for ID:", id);
            return res.status(404).json({ 
                success: false, 
                error: "No valid request found" 
            });
        }

        const request = queryResult[0];
        
        // Validate request data
        if (!request.receiptid || !request.name) {
            console.error("❌ Invalid request data:", request);
            return res.status(400).json({ 
                success: false, 
                error: "Invalid request data" 
            });
        }

        const folderName = `Order-${request.receiptid}-${request.name}`.replace(/[^a-zA-Z0-9-]/g, '_');
        console.log(`📂 Creating folder: ${folderName}`);

        let folderId;
        try {
            folderId = await createFolder(folderName);
            console.log("✅ Folder ID:", folderId);
        } catch (error) {
            console.error("❌ Folder creation failed:", error.message);
            return res.status(500).json({ success: false, error: "Google Drive folder error." });
        }

        console.log("🔗 Sharing folder...");
        await shareFolder(folderId, process.env.PERSONAL_EMAIL);

        const uploadedFiles = [];
        for (const file of req.files) {
            console.log(`📤 Uploading ${file.originalname}...`);
            const fileId = await uploadFile(file.path, file.originalname, folderId);
            uploadedFiles.push({ fileName: file.originalname, fileId });
            console.log(`✅ Uploaded ${file.originalname} with ID: ${fileId}`);

            try {
                await unlink(file.path);
                console.log(`🗑️ Deleted temp file: ${file.path}`);
            } catch (unlinkError) {
                console.error(`⚠️ Failed to delete temp file: ${file.path}`, unlinkError.message);
            }
        }

        console.log("✅ All files uploaded successfully!");

        const centralTimestamp = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Chicago',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            hour12: true,
        }).format(new Date());

        console.log("🔄 Updating database status...");
        await db.query(
            `UPDATE requests SET status = $1, timestamp = $2 WHERE id = $3`,
            ['Completed', centralTimestamp, id]
        );

        res.status(200).json({
            success: true,
            message: 'Files uploaded successfully.',
            files: uploadedFiles,
        });
    } catch (error) {
        console.error("🚨 Detailed error in /upload:", error.stack);
        res.status(500).json({ success: false, error: error.message });
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

async function sendUploadEmail(recipientEmail, uploadLink) {
    const mailOptions = {
        from: `"File Upload Service" <${process.env.PERSONAL_EMAIL}>`,
        to: recipientEmail,
        subject: "Upload Your Files for Order",
        html: `
            <h1>File Upload Required</h1>
            <p>Please upload your files for order processing.</p>
            <a href="${uploadLink}" style="background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Upload Files</a>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log("📧 Email sent to:", recipientEmail);
    } catch (error) {
        console.error("❌ Email Error:", error);
    }
};

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});