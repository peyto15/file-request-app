# 📂✨ File Request App – Easy, Secure & Hassle-Free File Uploads 🚀💾  

## 🎨 Crop, Upload & Share Files in Seconds! 🖼️📤  

Welcome to the **File Request App**—a super smooth way to collect files from users with **real-time image cropping** and **direct Google Drive uploads**! 🏆 Whether you're a freelancer, a small business owner, or just need an easy way to gather documents, this app keeps it simple. Drag-and-drop your files, tweak images with built-in cropping ✂️, and hit upload. The app even has a **loading spinner** so you know things are happening behind the scenes. ⚡ Plus, after a successful upload, it auto-refreshes so everything stays clean and updated! 🔄✅  

## 🔒 Secure, Smart & Hands-Free Automation 🤖🛡️  

Under the hood, this app runs on **Node.js, Express, PostgreSQL, and Google Drive API**—so it's fast, safe, and reliable. 🚀 All uploaded files get stored in **dedicated Google Drive folders**, with automatic sharing permissions set up. 🗂️ Got limits? No worries! **Server-side validation** ensures only images (JPG/PNG) and PDFs make the cut, and file size restrictions keep things optimized. 📏 A **background cron job** (fancy term for an automated task ⏳) keeps things tidy by updating request statuses, so you don’t have to babysit the system.  

## 🛠️ Ready to Use & Customize to Your Heart’s Content! 🎛️💡  

Want to run this on your own server? **It’s deployment-ready!** 🖥️ Push it to **Render, Vercel, or your own VPS** in minutes. 🌍 The database is flexible, letting you run it **locally or in the cloud** depending on your needs. 🌤️ Developers can easily extend functionality—add authentication, tweak the UI, or even connect it to more storage services. 🚀 With well-structured APIs and a modular build, you can customize things without breaking a sweat. Ready to streamline file uploads and make life easier? **Let’s go!** 💪🔥  

## 🚀 Quick Start Guide – Get Up & Running in Minutes! 🏁  

### 🔧 Prerequisites – What You’ll Need:  

Before diving in, make sure you’ve got:  

✅ **Node.js** (v16+ recommended) – [Download here](https://nodejs.org/)  
✅ **PostgreSQL** (Local or cloud-based like Render) – [Install it here](https://www.postgresql.org/)  
✅ **Google Cloud Project** (with Drive API enabled) – [Set it up here](https://console.cloud.google.com/)  
✅ **Git & a Terminal** (Bash, CMD, or PowerShell) – [Get Git](https://git-scm.com/)  

---

### 📥 1. Clone the Repo & Install Dependencies  
First, grab the code and install the required packages:  

```bash
git clone https://github.com/your-username/file-request-app.git
cd file-request-app
npm install
```
Boom! 💥 Now you’ve got all dependencies ready to roll! 🎯

### ⚙️ 2. Set Up Environment Variables
Create a **.env** file in the root folder and add:
```bash
PORT=3000
DATABASE_URL=postgres://your-user:your-password@localhost:5432/your-database
DATABASE_SSL=false
CLIENT_EMAIL=your-google-service-account@yourproject.iam.gserviceaccount.com
PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR-PRIVATE-KEY-HERE\n-----END PRIVATE KEY-----\n"
PERSONAL_EMAIL=your-email@gmail.com
EMAIL_PASSWORD=your-email-password
```
📌 Important Notes:
- The **Google Drive API setup** requires a **service account JSON key**.
- Use a **valid database URL** (Update DATABASE_URL for Render if hosting remotely).

### 🛠 3. Initialize the Database
Run the following in your terminal to create the **requests** table:
```bash
psql -U your-user -d your-database -f database/schema.sql
```
Or if you’re using a cloud database like **Render**, log in and create the table manually:
```sql
CREATE TABLE requests (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    receiptId TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'Pending'
);
```
### ▶️ 4. Start the App Locally
Fire up the server and test locally:
```bash
npm start
```
Now visit http://localhost:3000 in your browser. 🎉

### 🚀 5. Deploy to Render (or Any Cloud Service)
Ready to go live? 🌍 Deploy your app with Render:
1️⃣ Push your code to GitHub:
```bash
git add .
git commit -m "🚀 Initial deployment setup"
git push origin main
```
2️⃣ Log into **Render.com** & create a **Web Service**
3️⃣ Set DATABASE_URL in **Environment Variables**
4️⃣ Deploy! 🎉

⏳ Once deployed, test your live URL & ensure everything works! 🚀

















