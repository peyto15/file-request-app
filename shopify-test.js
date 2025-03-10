const express = require("express");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// ✅ Webhook Middleware: Use express.raw() to get raw body
app.use("/shopify-webhook", express.raw({ type: "application/json" }));

// 🛒 Shopify Webhook Route
app.post("/shopify-webhook", (req, res) => {
    console.log("\n🛒 Incoming Shopify Webhook!");
    console.log("📩 Headers:", req.headers);
    console.log("📦 Raw Body (First 200 chars):", req.body ? req.body.toString().slice(0, 200) : "❌ Missing rawBody");

    // Validate HMAC
    const hmac = req.get("X-Shopify-Hmac-Sha256");
    if (!hmac) {
        console.log("❌ No HMAC signature found");
        return res.status(400).send("Missing HMAC signature");
    }

    if (!req.body || req.body.length === 0) {
        console.log("🚨 Error: Missing rawBody in request. Middleware failed!");
        return res.status(400).send("Invalid request body");
    }

    console.log("📩 Raw Body Received (First 100 chars):", req.body.toString().slice(0, 100));

    // Compute HMAC
    const hash = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
                       .update(req.body) // Use captured rawBody
                       .digest("base64");

    if (hmac !== hash) {
        console.log("❌ Unauthorized - Invalid Shopify Signature");
        return res.status(401).send("Unauthorized");
    }

    console.log("✅ Shopify Order Verified!");
    console.log("📦 Full Order Data:", JSON.parse(req.body.toString())); // Convert back to JSON

    res.status(200).send("Order processed successfully.");
});

// 🔥 Start Test Server
app.listen(PORT, () => {
    console.log(`🚀 Test Webhook Server running on http://localhost:${PORT}`);
});