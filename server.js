// ─────────────────────────────────────────────────────────────────────────────
// server.js
//
// AMBIENCE — Express + MongoDB Atlas Application Server
//
// Architecture:
//   • dotenv loaded FIRST (line 1) — before ANY other import
//   • Mongoose connects to MongoDB Atlas with retry logic
//   • Auth routes delegated to controllers/auth.js (clean separation)
//   • Photo processing + health check handled inline
//   • Graceful shutdown on SIGTERM/SIGINT
//
// Auth Endpoints (via controllers/auth.js):
//   POST /api/auth/register        — Create account + send OTP
//   POST /api/auth/verify-otp      — Server-side OTP verification
//   POST /api/auth/login           — Email/password login (with lockout)
//   POST /api/auth/logout          — Stateless (client removes token)
//   POST /api/auth/forgot-password — Send password reset OTP
//   POST /api/auth/reset-password  — Verify reset OTP + set new password
//   POST /api/auth/resend-otp      — Resend verification code
//   POST /api/auth/google          — Google OAuth 2.0 token verification
//   POST /api/auth/twitter         — Twitter/X OAuth 2.0 PKCE
//   POST /api/auth/guest           — Guest session (24h JWT)
//   GET  /api/auth/session         — Validate session token (protected)
//
// Other Endpoints:
//   POST /api/process-photo        — Photo upload + feedback email
//   GET  /api/health               — Health check (includes DB status)
//
// Stack: Node.js · Express · MongoDB Atlas · Mongoose · JWT · Helmet · CORS
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 0: Load environment variables BEFORE anything else
// This MUST be the very first executable line in the file.
// ═══════════════════════════════════════════════════════════════════════════════
require("dotenv").config();

const express    = require("express");
const mongoose   = require("mongoose");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const path       = require("path");
const multer     = require("multer");
const nodemailer = require("nodemailer");

// ── Auth system imports ─────────────────────────────────────────────────────
const authController = require("./controllers/auth");
const { protect, requireAdmin } = require("./middleware/auth");
const { restrictTo }            = require("./middleware/authMiddleware");

// ── Payment system imports ──────────────────────────────────────────────────
const paymentController = require("./controllers/paymentController");

// ── Enterprise security middleware ──────────────────────────────────────────
const cookieParser        = require("cookie-parser");
const mongoSanitize       = require("express-mongo-sanitize");
const hpp                 = require("hpp");
const { threatDetection } = require("./middleware/threatDetection");
const { sanitizeInputs, enforceJSON }  = require("./middleware/sanitize");
const { paymentGuard }    = require("./middleware/paymentGuard");

const Product = require("./models/Product");
const FlagshipDeal = require("./models/FlagshipDeal");
const Order = require("./models/Order");
const User = require("./models/User");
const SupportTicket = require("./models/SupportTicket");

// ── Email templates ─────────────────────────────────────────────────────────
const { generatePhotoFeedbackEmail } = require("./photo-feedback-template");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 5000;
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
const MONGO_URI  = process.env.MONGO_URI;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: Connect to MongoDB Atlas
//
// Uses Mongoose with retry logic. The server will NOT start listening until
// the database connection is established (fail-fast for production).
// ═══════════════════════════════════════════════════════════════════════════════
const connectDB = async () => {
  if (!MONGO_URI) {
    console.error("");
    console.error("╔══════════════════════════════════════════════════════════╗");
    console.error("║  ❌  MONGO_URI is undefined!                            ║");
    console.error("║                                                          ║");
    console.error("║  Make sure your server/.env file contains:               ║");
    console.error("║    MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net ║");
    console.error("║                                                          ║");
    console.error("║  Also verify:                                            ║");
    console.error("║    • require('dotenv').config() is the FIRST line        ║");
    console.error("║    • The .env file is in the server/ directory            ║");
    console.error("║    • No typos in the variable name                       ║");
    console.error("╚══════════════════════════════════════════════════════════╝");
    console.error("");
    process.exit(1);
  }

  // Mongoose connection event handlers
  mongoose.connection.on("connected", () => {
    console.log("  ✅  MongoDB Atlas connected successfully");
  });

  mongoose.connection.on("error", (err) => {
    console.error("  ❌  MongoDB connection error:", err.message);
  });

  mongoose.connection.on("disconnected", () => {
    console.warn("  ⚠️   MongoDB disconnected");
  });

  try {
    await mongoose.connect(MONGO_URI, {
      // ── Connection Pool ─────────────────────────────────────────────────
      maxPoolSize: 10,
      minPoolSize: 2,

      // ── Timeouts (prevents requests from hanging indefinitely) ────────
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,

      // ── Heartbeat ─────────────────────────────────────────────────────
      heartbeatFrequencyMS: 10000,

      // ── Write Concern ─────────────────────────────────────────────────
      retryWrites: true,
      w: "majority",
    });
  } catch (err) {
    console.error("");
    console.error("╔══════════════════════════════════════════════════════════╗");
    console.error("║  ❌  MongoDB Atlas connection FAILED                     ║");
    console.error("╚══════════════════════════════════════════════════════════╝");
    console.error("");
    console.error("  Error:", err.message);
    console.error("");
    console.error("  Common fixes:");
    console.error("    1. Check your MONGO_URI in server/.env");
    console.error("    2. Whitelist your IP in Atlas: Network Access → Add IP");
    console.error("    3. Verify username/password are correct");
    console.error("    4. Hostname must be .mongodb.net (NOT .ambience_db.net)");
    console.error("    5. Database name goes in the PATH: /ambience_db");
    console.error("");
    process.exit(1);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: Initialize Express
// ═══════════════════════════════════════════════════════════════════════════════
const app = express();

// ── Security headers via Helmet (Enterprise Hardened) ───────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https:"],
      fontSrc: ["'self'", "https:", "data:"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  frameguard: { action: "deny" },
  noSniff: true,
  xssFilter: true,
}));

// ── Cookie parser (required for httpOnly refresh token cookies) ─────────────
app.use(cookieParser());

// ── CORS — Strict origin whitelist with credentials ─────────────────────────
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "https://ambienced.netlify.app",
  "https://ambience-fronten.vercel.app",
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked request from unauthorized origin: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400,
}));

// ── JSON body parser ────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));

// ── NoSQL Injection Prevention ──────────────────────────────────────────────
app.use(mongoSanitize());

// ── HTTP Parameter Pollution protection ─────────────────────────────────────
app.use(hpp());

// ── Threat Detection (per-IP anomaly tracking + auto-blocking) ──────────────
app.use(threatDetection);

// ── Deep Input Sanitization (XSS + prototype pollution prevention) ──────────
app.use(sanitizeInputs);

// ── Content-Type Enforcement (blocks non-JSON mutation requests) ────────────
app.use(enforceJSON);

// ── Payment Data Guard (blocks raw financial data in requests) ──────────────
app.use(paymentGuard);

// ── Global API Rate Limiter ─────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please slow down." },
});
app.use("/api", globalLimiter);

// ── Database readiness middleware ───────────────────────────────────────────
// Returns a clear 503 JSON error when MongoDB is disconnected, instead of
// letting Mongoose operations hang and produce browser-level network errors.
app.use("/api", (req, res, next) => {
  // 1 = connected — see https://mongoosejs.com/docs/api/connection.html
  if (mongoose.connection.readyState !== 1) {
    const stateNames = ["disconnected", "connected", "connecting", "disconnecting"];
    const state = stateNames[mongoose.connection.readyState] || "unknown";
    console.error(`[DB Guard] Request blocked — MongoDB is ${state}`);
    return res.status(503).json({
      success: false,
      error: "Service temporarily unavailable — database is reconnecting. Please try again in a few seconds.",
    });
  }
  next();
});

// ── File upload middleware (multer) ─────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/webp"];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only JPEG, PNG, and WebP are allowed."));
    }
  },
});

// ── Serve static assets (logo, images) ──────────────────────────────────────
app.use("/assets", express.static(path.join(__dirname, "assets")));

// ── Rate limiters ───────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please try again after 15 minutes." },
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many OTP requests. Please try again after 15 minutes." },
});

const socialAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many authentication attempts. Please try again later." },
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many payment requests. Please try again after 15 minutes." },
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: Email Service (shared Nodemailer/Gmail transporter)
// ═══════════════════════════════════════════════════════════════════════════════
const { sendEmail: sendServiceEmail, isEmailConfigured } = require("./utils/emailService");

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: Auth Routes — Delegated to controllers/auth.js
//
// All authentication logic lives in controllers/auth.js (Mongoose-based).
// Each handler uses the User model (models/User.js) for MongoDB operations.
// ═══════════════════════════════════════════════════════════════════════════════

// Registration & Verification
app.post("/api/auth/register",    authLimiter, authController.register);
app.post("/api/auth/verify-otp",  otpLimiter,  authController.verifyOTP);
app.post("/api/auth/resend-otp",  otpLimiter,  authController.resendOTP);

// Login
app.post("/api/auth/login",       authLimiter, authController.login);
app.post("/api/auth/logout",      authController.logout);

// Social OAuth
app.post("/api/auth/google",      socialAuthLimiter, authController.googleLogin);
app.post("/api/auth/twitter",     socialAuthLimiter, authController.twitterAuth);
app.post("/api/auth/apple",      socialAuthLimiter, authController.appleLogin);

// Guest Session
app.post("/api/auth/guest",       authController.createGuestSession);

// Session Validation (protected)
app.get("/api/auth/session",      protect, authController.getSession);

// Token Refresh (uses httpOnly cookie)
app.post("/api/auth/refresh",     authController.refreshToken);

// Password Reset
app.post("/api/auth/forgot-password", otpLimiter, authController.forgotPassword);
app.post("/api/auth/reset-password",  authLimiter, authController.resetPassword);

// Profile Management (protected)
app.put("/api/auth/update-profile",   protect, authController.updateProfile);

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4.2: User Address Management Routes
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/users/addresses — Fetch all saved addresses
app.get("/api/users/addresses", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("savedAddresses");
    if (!user) return res.status(404).json({ success: false, error: "User not found." });
    return res.status(200).json({ success: true, addresses: user.savedAddresses });
  } catch (err) {
    console.error("[AMBIENCE] ❌ Fetch addresses error:", err.message);
    return res.status(500).json({ success: false, error: "Failed to fetch addresses." });
  }
});

// POST /api/users/addresses — Add a new shipping address
app.post("/api/users/addresses", protect, async (req, res) => {
  try {
    const { label, houseNo, street, landmark, city, state, zip, country, isDefault } = req.body;
    if (!houseNo || !street || !city || !state || !zip) {
      return res.status(400).json({ success: false, error: "House No., Street, City, State, and Pincode are required." });
    }
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, error: "User not found." });

    // If this address is default, unset all others
    if (isDefault) {
      user.savedAddresses.forEach(addr => { addr.isDefault = false; });
    }
    // If it's the first address, make it default
    const makeDefault = isDefault || user.savedAddresses.length === 0;

    user.savedAddresses.push({ label: label || "Home", houseNo, street, landmark: landmark || "", city, state, zip, country: country || "India", isDefault: makeDefault });
    await user.save();

    console.log(`[AMBIENCE] ✅ Address added for ${user.email}`);
    return res.status(201).json({ success: true, message: "Address added successfully.", addresses: user.savedAddresses });
  } catch (err) {
    console.error("[AMBIENCE] ❌ Add address error:", err.message);
    if (err.name === "ValidationError") {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ success: false, error: messages.join(", ") });
    }
    return res.status(500).json({ success: false, error: "Failed to add address." });
  }
});

// PUT /api/users/addresses/:addressId — Update an existing address
app.put("/api/users/addresses/:addressId", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, error: "User not found." });

    const address = user.savedAddresses.id(req.params.addressId);
    if (!address) return res.status(404).json({ success: false, error: "Address not found." });

    const { label, houseNo, street, landmark, city, state, zip, country, isDefault } = req.body;
    if (label !== undefined) address.label = label;
    if (houseNo !== undefined) address.houseNo = houseNo;
    if (street !== undefined) address.street = street;
    if (landmark !== undefined) address.landmark = landmark;
    if (city !== undefined) address.city = city;
    if (state !== undefined) address.state = state;
    if (zip !== undefined) address.zip = zip;
    if (country !== undefined) address.country = country;
    if (isDefault) {
      user.savedAddresses.forEach(addr => { addr.isDefault = false; });
      address.isDefault = true;
    }

    await user.save();
    console.log(`[AMBIENCE] ✅ Address updated for ${user.email}`);
    return res.status(200).json({ success: true, message: "Address updated.", addresses: user.savedAddresses });
  } catch (err) {
    console.error("[AMBIENCE] ❌ Update address error:", err.message);
    return res.status(500).json({ success: false, error: "Failed to update address." });
  }
});

// DELETE /api/users/addresses/:addressId — Remove an address
app.delete("/api/users/addresses/:addressId", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, error: "User not found." });

    const address = user.savedAddresses.id(req.params.addressId);
    if (!address) return res.status(404).json({ success: false, error: "Address not found." });

    const wasDefault = address.isDefault;
    user.savedAddresses.pull(req.params.addressId);

    // If the deleted address was default, make the first remaining one default
    if (wasDefault && user.savedAddresses.length > 0) {
      user.savedAddresses[0].isDefault = true;
    }

    await user.save();
    console.log(`[AMBIENCE] ✅ Address deleted for ${user.email}`);
    return res.status(200).json({ success: true, message: "Address removed.", addresses: user.savedAddresses });
  } catch (err) {
    console.error("[AMBIENCE] ❌ Delete address error:", err.message);
    return res.status(500).json({ success: false, error: "Failed to delete address." });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4.2b: Account Settings Routes
// Password change, notification preferences, 2FA, support tickets
// ═══════════════════════════════════════════════════════════════════════════════

// ── Change Password (logged-in user) ────────────────────────────────────────
app.put("/api/auth/change-password", protect, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ success: false, error: "All password fields are required" });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, error: "New password and confirmation do not match" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, error: "New password must be at least 8 characters" });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ success: false, error: "New password must differ from current password" });
    }

    const user = await User.findById(req.user._id).select("+password");
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    // Verify current password
    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: "Current password is incorrect" });
    }

    // Set new password — pre-save hook handles hashing + complexity validation
    user.password = newPassword;
    await user.save();

    console.log(`[AMBIENCE] ✅ Password changed for ${user.email}`);
    res.json({ success: true, message: "Password updated successfully" });
  } catch (err) {
    console.error("[Change Password]", err.message);
    if (err.name === "ValidationError") {
      return res.status(400).json({ success: false, error: err.message });
    }
    res.status(500).json({ success: false, error: "Failed to update password" });
  }
});

// ── Update Notification Preferences ─────────────────────────────────────────
app.put("/api/users/notifications", protect, async (req, res) => {
  try {
    const allowed = ["email", "push", "sms", "orderTracking", "promotional", "securityAlerts"];
    const updates = {};

    for (const key of allowed) {
      if (typeof req.body[key] === "boolean") {
        updates[`notifications.${key}`] = req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: "No valid notification fields provided" });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    res.json({ success: true, message: "Notification preferences updated", notifications: user.notifications });
  } catch (err) {
    console.error("[Update Notifications]", err.message);
    res.status(500).json({ success: false, error: "Failed to update notification preferences" });
  }
});

// ── Toggle Two-Factor Authentication ────────────────────────────────────────
app.put("/api/users/2fa", protect, async (req, res) => {
  try {
    const { enabled, method } = req.body;

    if (typeof enabled !== "boolean") {
      return res.status(400).json({ success: false, error: "'enabled' must be a boolean" });
    }

    const validMethods = ["email", "sms", "authenticator", ""];
    const safeMethod = validMethods.includes(method) ? method : "email";

    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        $set: {
          "twoFactorAuth.enabled": enabled,
          "twoFactorAuth.method": enabled ? safeMethod || "email" : "",
        },
      },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    console.log(`[AMBIENCE] ✅ 2FA ${enabled ? "enabled" : "disabled"} for ${user.email}`);
    res.json({
      success: true,
      message: enabled ? "Two-factor authentication enabled" : "Two-factor authentication disabled",
      twoFactorAuth: { enabled: user.twoFactorAuth.enabled, method: user.twoFactorAuth.method },
    });
  } catch (err) {
    console.error("[2FA Toggle]", err.message);
    res.status(500).json({ success: false, error: "Failed to update 2FA settings" });
  }
});

// ── Create Support Ticket ───────────────────────────────────────────────────
app.post("/api/support", protect, async (req, res) => {
  try {
    const { category, orderId, message } = req.body;

    if (!category || !message) {
      return res.status(400).json({ success: false, error: "Category and message are required" });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const ticket = await SupportTicket.create({
      user: user._id,
      userName: user.displayName || user.name || user.email?.split("@")[0] || "User",
      userEmail: user.email || "",
      category,
      orderId: orderId || "",
      message: message.trim(),
    });

    console.log(`[AMBIENCE] ✅ Support ticket created: ${ticket._id} by ${user.email}`);
    res.status(201).json({
      success: true,
      message: "Your ticket has been sent to our Admin team",
      ticket: {
        _id: ticket._id,
        category: ticket.category,
        status: ticket.status,
        createdAt: ticket.createdAt,
      },
    });
  } catch (err) {
    console.error("[Create Support Ticket]", err.message);
    if (err.name === "ValidationError") {
      const messages = Object.values(err.errors).map((e) => e.message).join(", ");
      return res.status(400).json({ success: false, error: messages });
    }
    res.status(500).json({ success: false, error: "Failed to create support ticket" });
  }
});

// ── Admin: Get All Support Tickets ──────────────────────────────────────────
app.get("/api/admin/support-tickets", protect, requireAdmin, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status && ["open", "in-progress", "resolved", "closed"].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const tickets = await SupportTicket.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, tickets, count: tickets.length });
  } catch (err) {
    console.error("[Admin Get Tickets]", err.message);
    res.status(500).json({ success: false, error: "Failed to fetch support tickets" });
  }
});

// ── Admin: Update Support Ticket Status ─────────────────────────────────────
app.put("/api/admin/support-tickets/:id/status", protect, requireAdmin, async (req, res) => {
  try {
    const { status, adminNotes } = req.body;

    if (!status || !["open", "in-progress", "resolved", "closed"].includes(status)) {
      return res.status(400).json({ success: false, error: "Valid status is required" });
    }

    const updates = { status };
    if (typeof adminNotes === "string") {
      updates.adminNotes = adminNotes.trim();
    }

    const ticket = await SupportTicket.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!ticket) {
      return res.status(404).json({ success: false, error: "Ticket not found" });
    }

    console.log(`[AMBIENCE] ✅ Ticket ${ticket._id} status → ${status}`);
    res.json({ success: true, message: "Ticket updated", ticket });
  } catch (err) {
    console.error("[Admin Update Ticket]", err.message);
    res.status(500).json({ success: false, error: "Failed to update ticket" });
  }
});

// ── Admin: Delete Support Ticket ────────────────────────────────────────────
app.delete("/api/admin/support-tickets/:id", protect, requireAdmin, async (req, res) => {
  try {
    const ticket = await SupportTicket.findByIdAndDelete(req.params.id);
    if (!ticket) {
      return res.status(404).json({ success: false, error: "Ticket not found" });
    }
    console.log(`[AMBIENCE] 🗑️ Ticket ${ticket._id} deleted by admin`);
    res.json({ success: true, message: "Ticket deleted" });
  } catch (err) {
    console.error("[Admin Delete Ticket]", err.message);
    res.status(500).json({ success: false, error: "Failed to delete ticket" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4.3: Payment Routes — Razorpay Integration
//
// All payment routes are JWT-protected and rate-limited.
// The paymentGuard middleware (global) already blocks raw financial data.
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/payment/create-order", paymentLimiter, protect, paymentController.createOrder);
app.post("/api/payment/verify",       paymentLimiter, protect, paymentController.verifyPayment);

// ── Order History (protected) ───────────────────────────────────────────────
app.get("/api/orders/my-orders",      protect, paymentController.getMyOrders);

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4.5: Product Management Routes
//
// ⚠️  ROUTE ORDER MATTERS! In Express, static path segments (like /pending)
//     MUST be declared BEFORE parameterized segments (like /:id).
//     Otherwise Express matches "pending" as an :id param → Mongoose CastError.
// ═══════════════════════════════════════════════════════════════════════════════

app.get("/api/products", async (req, res) => {
  try {
    // ── Admin bypass: ?admin=true returns ALL products (including Deals Page) ──
    // This prevents the "vanishing product" bug where Deals Page products
    // disappeared from the Admin Panel's product list.
    if (req.query.admin === 'true') {
      // Verify the requester is actually an admin via JWT
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const token = authHeader.split(' ')[1];
          const jwt = require('jsonwebtoken');
          const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
          const User = require('./models/User');
          const dbUser = await User.findById(decoded.id).select('role');
          if (dbUser && dbUser.role === 'admin') {
            const allProducts = await Product.find({ status: 'live' }).sort({ createdAt: -1 });
            return res.status(200).json({ success: true, products: allProducts });
          }
        } catch (_jwtErr) {
          // JWT verification failed — fall through to public filter
        }
      }
    }

    // SECURITY: Strictly exclude Deals Page products and pending deals from the
    // public shop feed. Deals products belong exclusively in the Deals Vault.
    const products = await Product.find({
      status: "live",
      category: { $nin: ["Deals Page", "deals page"] },
    }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, products });
  } catch (error) {
    console.error("[AMBIENCE] ❌ Error fetching products:", error.message);
    return res.status(500).json({ success: false, error: "Failed to fetch products" });
  }
});

// ── Admin: Fetch all pending submissions ────────────────────────────────────
// ⚠️  This MUST be above /api/products/:id — see route order note above.
app.get("/api/products/pending", protect, restrictTo("admin"), async (req, res) => {
  try {
    console.log("[AMBIENCE] 📋 Admin fetching pending products...");

    const products = await Product.find({ status: "pending", isApproved: false })
      .sort({ createdAt: -1 });

    console.log(`[AMBIENCE] ✅ Found ${products.length} pending product(s)`);
    return res.status(200).json({ success: true, products });
  } catch (error) {
    console.error("[AMBIENCE] ❌ Error fetching pending products:", error.message);
    console.error("[AMBIENCE]    Stack:", error.stack);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch pending products",
    });
  }
});

// ─── Deals Live Products (PUBLIC) — For the Deals Page frontend ────────────
// Returns approved Deals Page products (category: 'Deals Page', status: 'live').
// This endpoint solves the double-blind filter issue where GET /api/products
// excluded Deals Page products, making approved deals invisible on the Deals Page.
app.get('/api/products/deals-live', async (req, res) => {
  try {
    const dealsProducts = await Product.find({
      status: 'live',
      category: { $in: ['Deals Page', 'deals page'] },
      isApproved: true,
    }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, products: dealsProducts });
  } catch (error) {
    console.error('[AMBIENCE] ❌ Error fetching deals-live products:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch deals products' });
  }
});

// ─── Deals Verification Queue ──────────────────────────────────────────────
app.get('/api/products/pending-deals', protect, restrictTo('admin'), async (req, res) => {
  try {
    const deals = await Product.find({ status: 'pending_deals_approval' }).sort({ createdAt: -1 });
    res.json({ success: true, deals });
  } catch (err) {
    console.error('[Deals Queue]', err);
    res.status(500).json({ success: false, message: 'Failed to fetch deals queue' });
  }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    // ── Validate ObjectId to prevent Mongoose CastError ────────────────────
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: "Invalid product ID format" });
    }

    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }
    return res.status(200).json({ success: true, product });
  } catch (error) {
    console.error("[AMBIENCE] ❌ Error fetching single product:", error.message);
    return res.status(500).json({ success: false, error: "Failed to fetch product" });
  }
});

// ── Admin: Create product (PROTECTED — requires admin JWT) ───────────────────
app.post("/api/products", protect, requireAdmin, async (req, res) => {
  try {
    // ── SECURITY: Explicit field whitelist (prevents mass-assignment attacks) ──
    const {
      name, brand, category, subcategory, description,
      retailPrice, dealPrice, imageUrl, additionalImages,
      modelUrl, has3DModel, sizeVariants, colorVariants,
      targetSection, tag, glyph, accent,
      hasARSupport, arModelUrl, arModelScale, arModelPosition,
      // Color variant fields for 3D AR
      colorVariantModels,
      // Multi-image & gallery fields
      imageUrls, subImages,
      // Product detail fields
      highlights, tags, spec, dynamicSpecs,
      // Category-specific specifications
      specifications,
    } = req.body;

    const product = new Product({
      name, brand, category, subcategory, description,
      retailPrice, dealPrice, imageUrl, additionalImages,
      modelUrl, has3DModel, sizeVariants, colorVariants,
      targetSection, tag, glyph, accent,
      hasARSupport, arModelUrl, arModelScale, arModelPosition,
      colorVariantModels,
      // Multi-image fields (sanitized)
      imageUrls: Array.isArray(imageUrls) ? imageUrls.filter(u => typeof u === 'string' && u.trim()) : [],
      subImages: Array.isArray(subImages) ? subImages.filter(u => typeof u === 'string' && u.trim()) : [],
      // Product detail fields (sanitized)
      highlights: Array.isArray(highlights) ? highlights.filter(h => typeof h === 'string' && h.trim()) : [],
      tags: Array.isArray(tags) ? tags.filter(t => t && (typeof t === 'string' ? t.trim() : typeof t === 'object')) : [],
      spec: typeof spec === 'string' ? spec.trim() : '',
      dynamicSpecs: Array.isArray(dynamicSpecs) ? dynamicSpecs.filter(ds => ds && typeof ds === 'object' && ds.label && ds.value) : [],
      // Category specifications — must be a plain object for Mongoose Map
      specifications: (specifications && typeof specifications === 'object' && !Array.isArray(specifications))
        ? Object.fromEntries(Object.entries(specifications).filter(([k, v]) => typeof k === 'string' && k.trim() && typeof v === 'string' && v.trim()))
        : {},
      // SECURITY: Force these fields — cannot be set by the request
      status: "live",
      isApproved: true,
      isOfficial: true,
      addedBy: req.user?.email || "admin",
      source: "admin",
    });

    await product.save();
    console.log(`[AMBIENCE] ✅ Admin product created: "${product.name}" by ${req.user?.email}`);
    return res.status(201).json({ success: true, product, message: "Product deployed successfully." });
  } catch (error) {
    console.error("[AMBIENCE] ❌ Error creating product:", error.name, error.message);
    if (error.name === "ValidationError" && error.errors) {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ success: false, error: messages.join(". ") });
    }
    // CastError, ValidationError without .errors, or any other Mongoose error
    return res.status(400).json({ success: false, error: error.message || "Failed to create product" });
  }
});

// ── Admin: Delete product (PROTECTED — requires admin JWT) ───────────────────
app.delete("/api/products/:id", protect, requireAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: "Invalid product ID format" });
    }
    const deleted = await Product.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }
    console.log(`[AMBIENCE] 🗑️ Admin deleted product: "${deleted.name}" by ${req.user?.email}`);
    return res.status(200).json({ success: true, message: "Product removed." });
  } catch (error) {
    console.error("[AMBIENCE] ❌ Error deleting product:", error.message);
    return res.status(500).json({ success: false, error: "Failed to delete product" });
  }
});

// ── Admin: Update product (PROTECTED — requires admin JWT) ───────────────────
app.put("/api/products/:id", protect, requireAdmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: "Invalid product ID format" });
    }

    // SECURITY: Explicit field whitelist (prevents mass-assignment attacks)
    const allowedFields = [
      'name', 'brand', 'category', 'subcategory', 'description',
      'retailPrice', 'dealPrice', 'imageUrl', 'additionalImages',
      'modelUrl', 'has3DModel', 'sizeVariants', 'colorVariants',
      'targetSection', 'tag', 'glyph', 'accent',
      'hasARSupport', 'arModelUrl', 'arModelScale', 'arModelPosition',
      'colorVariantModels',
      // Multi-image & gallery fields
      'imageUrls', 'subImages',
      // Product detail fields
      'highlights', 'tags', 'spec', 'dynamicSpecs',
      // Category-specific specifications
      'specifications',
    ];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        // Extra sanitization for specifications (must be clean object for Map)
        if (field === 'specifications') {
          const raw = req.body[field];
          updates[field] = (raw && typeof raw === 'object' && !Array.isArray(raw))
            ? Object.fromEntries(Object.entries(raw).filter(([k, v]) => typeof k === 'string' && k.trim() && typeof v === 'string' && v.trim()))
            : {};
        } else {
          updates[field] = req.body[field];
        }
      }
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!product) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }
    console.log(`[AMBIENCE] ✅ Admin updated product: "${product.name}" by ${req.user?.email}`);
    return res.status(200).json({ success: true, product, message: "Product updated successfully." });
  } catch (error) {
    console.error("[AMBIENCE] ❌ Error updating product:", error.name, error.message);
    if (error.name === "ValidationError" && error.errors) {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ success: false, error: messages.join(". ") });
    }
    return res.status(400).json({ success: false, error: error.message || "Failed to update product" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4.6: Creator Hub — User Product Submission Pipeline
//
// Flow: User submits via Creator Hub → saved as pending → Admin moderates
//   POST   /api/products/create       → User submits product (status: pending)
//   GET    /api/products/pending       → (moved to STEP 4.5 — route order fix)
//   PUT    /api/products/:id/approve   → Admin approves → status: live
//   DELETE /api/products/:id/reject    → Admin rejects → deleted from DB
// ═══════════════════════════════════════════════════════════════════════════════

// ── User: Get their submissions ─────────────────────────────────────────────
// Uses req.user._id (MongoDB ObjectId) as the canonical identifier.
// Also checks userId (UUID) and email as fallbacks for legacy products.
app.get("/api/products/my-submissions", protect, async (req, res) => {
  try {
    const mongoId = req.user?._id?.toString();
    const uuidId = req.user?.userId;
    const email = req.user?.email;
    if (!mongoId && !uuidId) return res.status(401).json({ success: false, error: "Unauthorized" });

    // Query by any possible identifier the product may have been saved with
    const orConditions = [];
    if (mongoId) orConditions.push({ submittedBy: mongoId });
    if (uuidId)  orConditions.push({ submittedBy: uuidId });
    if (email)   orConditions.push({ submittedBy: email });

    const submissions = await Product.find({
      $or: orConditions,
      source: "creator_hub"
    }).sort({ createdAt: -1 });
    return res.status(200).json({ success: true, submissions });
  } catch (error) {
    console.error("[AMBIENCE] ❌ Error fetching submissions:", error.message);
    return res.status(500).json({ success: false, error: "Failed to fetch submissions" });
  }
});

// ── User: Update their submission ───────────────────────────────────────────
app.put('/api/products/my-submissions/:id', protect, async (req, res) => {
  try {
    const mongoId = req.user?._id?.toString();
    const uuidId = req.user?.userId;
    const email = req.user?.email;
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    const isOwner = [mongoId, uuidId, email].filter(Boolean).includes(product.submittedBy);
    if (!isOwner) return res.status(403).json({ success: false, error: 'Not authorized to edit this product' });
    if (!['pending', 'live'].includes(product.status)) return res.status(400).json({ success: false, error: 'Cannot edit archived or rejected products' });
    const allowed = ['name', 'description', 'retailPrice', 'dealPrice', 'category', 'subcategory', 'imageUrl', 'modelUrl', 'sizeVariants', 'colorVariants'];
    for (const f of allowed) {
      if (req.body[f] !== undefined) {
        if (f === 'retailPrice' || f === 'dealPrice') { const v = parseFloat(req.body[f]); if (!isNaN(v) && v > 0) product[f] = v; }
        else product[f] = req.body[f];
      }
    }
    if (req.body.retailPrice && !req.body.dealPrice) product.dealPrice = parseFloat(req.body.retailPrice);
    await product.save();
    console.log(`[AMBIENCE] ✅ Creator updated: "${product.name}" by ${email}`);
    return res.status(200).json({ success: true, product, message: 'Product updated successfully' });
  } catch (error) {
    console.error('[AMBIENCE] ❌ Error updating creator product:', error.message);
    if (error.name === 'ValidationError') { return res.status(400).json({ success: false, error: Object.values(error.errors).map(e => e.message).join('. ') }); }
    return res.status(500).json({ success: false, error: 'Failed to update product' });
  }
});

// ── User: Archive/Cancel their submission ───────────────────────────────────
app.delete("/api/products/my-submissions/:id", protect, async (req, res) => {
  try {
    const mongoId = req.user?._id?.toString();
    const uuidId = req.user?.userId;
    const email = req.user?.email;
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, error: "Not found" });
    // Allow if submittedBy matches any of the user's identifiers
    const isOwner = [mongoId, uuidId, email].filter(Boolean).includes(product.submittedBy);
    if (!isOwner) return res.status(403).json({ success: false, error: "Forbidden" });
    
    // Soft delete by updating status to 'archived' instead of removing from DB
    product.status = "archived";
    await product.save();

    return res.status(200).json({ success: true, message: "Product archived successfully", status: "archived" });
  } catch (error) {
    console.error("[AMBIENCE] ❌ Error archiving product:", error.message);
    return res.status(500).json({ success: false, error: "Failed to archive product" });
  }
});

// ── User: Get their Deals Page submission stats ─────────────────────────────
// Returns analytics for the creator's Deals Page submissions only.
app.get("/api/products/my-deals-stats", protect, async (req, res) => {
  try {
    const mongoId = req.user?._id?.toString();
    const uuidId = req.user?.userId;
    const email = req.user?.email;
    if (!mongoId && !uuidId) return res.status(401).json({ success: false, error: "Unauthorized" });

    const orConditions = [];
    if (mongoId) orConditions.push({ submittedBy: mongoId });
    if (uuidId)  orConditions.push({ submittedBy: uuidId });
    if (email)   orConditions.push({ submittedBy: email });

    // Only count products submitted to the Deals Page category
    const dealsProducts = await Product.find({
      $or: orConditions,
      source: "creator_hub",
      category: { $in: ["Deals Page", "deals page"] },
    });

    const totalDeals     = dealsProducts.length;
    const pendingDeals   = dealsProducts.filter(p => p.status === "pending_deals_approval").length;
    const approvedDeals  = dealsProducts.filter(p => p.status === "live" && p.isApproved === true).length;

    return res.status(200).json({
      success: true,
      stats: { totalDeals, pendingDeals, approvedDeals },
    });
  } catch (error) {
    console.error("[AMBIENCE] ❌ Error fetching deals stats:", error.message);
    return res.status(500).json({ success: false, error: "Failed to fetch deals stats" });
  }
});

// ── User Submission: Create pending product ─────────────────────────────────
app.post("/api/products/create", protect, async (req, res) => {
  try {
    const {
      name, price, brand, category, subcategory, description, imageUrl,
      retailPrice: reqRetailPrice, dealPrice: reqDealPrice,
      isOfficial, submittedBy, source, hasARSupport, modelUrl,
      sizeVariants, colorVariants,
      highlights, specifications, dynamicSpecs, subImages,
    } = req.body;

    // ── Validation ──
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: "Product name is required." });
    }
    const priceVal = parseFloat(price);
    if (!price || isNaN(priceVal) || priceVal <= 0) {
      return res.status(400).json({ success: false, error: "Valid price is required." });
    }
    if (!category || !category.trim()) {
      return res.status(400).json({ success: false, error: "Category is required." });
    }
    if (!subcategory || !subcategory.trim()) {
      return res.status(400).json({ success: false, error: "Subcategory is required. Please select what type of product this is." });
    }
    if (!description || !description.trim()) {
      return res.status(400).json({ success: false, error: "Description is required." });
    }
    if (!imageUrl || !imageUrl.trim()) {
      return res.status(400).json({ success: false, error: "Product image is required." });
    }

    // ── Parse size/color variants (accept arrays or comma-separated strings) ──
    let parsedSizes = [];
    if (Array.isArray(sizeVariants)) {
      parsedSizes = sizeVariants.map(s => {
        if (typeof s === 'string') return { label: s.trim(), priceDelta: 0 };
        if (s && typeof s === 'object' && s.label) return { label: String(s.label).trim(), priceDelta: Number(s.priceDelta) || 0 };
        return null;
      }).filter(Boolean);
    } else if (typeof sizeVariants === "string" && sizeVariants.trim()) {
      parsedSizes = sizeVariants.split(",").map(s => ({ label: s.trim(), priceDelta: 0 })).filter(s => s.label);
    }

    let parsedColors = [];
    if (Array.isArray(colorVariants)) {
      parsedColors = colorVariants.map(c => {
        if (typeof c === 'string') return { name: c.trim(), hex: '#000000' };
        return c;
      }).filter(Boolean);
    } else if (typeof colorVariants === "string" && colorVariants.trim()) {
      parsedColors = colorVariants.split(",").map(s => ({ name: s.trim(), hex: '#000000' })).filter(Boolean);
    }

    // ── Parse highlights ──
    const parsedHighlights = Array.isArray(highlights)
      ? highlights.filter(h => typeof h === 'string' && h.trim()).map(h => h.trim())
      : [];

    // ── Parse dynamicSpecs ──
    const parsedDynamicSpecs = Array.isArray(dynamicSpecs)
      ? dynamicSpecs.filter(ds => ds && typeof ds === 'object' && ds.label?.trim() && ds.value?.trim())
      : [];

    // ── Parse specifications (key-value map) ──
    const parsedSpecifications = (specifications && typeof specifications === 'object' && !Array.isArray(specifications))
      ? Object.fromEntries(Object.entries(specifications).filter(([k, v]) => typeof k === 'string' && k.trim() && typeof v === 'string' && v.trim()))
      : {};

    // ── Parse subImages ──
    const parsedSubImages = Array.isArray(subImages)
      ? subImages.filter(u => typeof u === 'string' && u.trim())
      : [];

    // ── Compute prices ──
    const finalRetailPrice = parseFloat(reqRetailPrice) || priceVal;
    const finalDealPrice = parseFloat(reqDealPrice) || priceVal;

    let targetSection = "category_only";
    let status = "pending";

    if (category === 'Deals Page') {
      const User = require('./models/User');
      const creator = await User.findById(req.user._id);
      if (!creator?.proSubscription?.isActive || new Date(creator.proSubscription.expiresAt) <= new Date()) {
        return res.status(403).json({ success: false, error: 'Pro Plan subscription is required to submit to Deals Page.' });
      }
      if (priceVal < 100000) {
        return res.status(400).json({ success: false, error: 'Deals Page products must have a price of at least 1,00,000 INR.' });
      }
      targetSection = "deals_luxury";
      status = "pending_deals_approval";
    }

    const product = new Product({
      name: name.trim(),
      brand: (brand && brand.trim()) || "Community Creator",
      category: category.trim(),
      subcategory: subcategory.trim(),
      retailPrice: finalRetailPrice,
      dealPrice: finalDealPrice,
      description: description.trim(),
      highlights: parsedHighlights,
      dynamicSpecs: parsedDynamicSpecs,
      specifications: parsedSpecifications,
      imageUrl: imageUrl.trim(),
      subImages: parsedSubImages,
      modelUrl: modelUrl || "",
      has3DModel: hasARSupport === "true" || hasARSupport === true,
      sizeVariants: parsedSizes,
      colorVariants: parsedColors,
      targetSection: targetSection,
      status: status,
      isApproved: false,
      isOfficial: false,
      submittedBy: req.user?._id?.toString() || req.user?.userId || "unknown",
      source: source || "creator_hub",
      addedBy: req.user?.email || "creator",
      tags: req.body.tags || [],
      tag: req.body.tag || "CREATOR",
      glyph: "🎨",
      accent: "#a78bfa",
    });

    await product.save();

    console.log(`[AMBIENCE] 📦 New product submission: "${product.name}" by ${product.submittedBy} | Category: ${product.category} > ${product.subcategory} | Sizes: [${parsedSizes.join(", ")}] | Colors: [${parsedColors.join(", ")}]`);

    return res.status(201).json({
      success: true,
      product,
      message: "Product submitted for review!",
    });
  } catch (error) {
    console.error("[AMBIENCE] ❌ Error submitting product:", error.message);
    console.error("[AMBIENCE]    Stack:", error.stack);
    // Return Mongoose validation errors cleanly
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map(e => e.message);
      return res.status(400).json({ success: false, error: messages.join(". ") });
    }
    return res.status(500).json({ success: false, error: "Failed to submit product" });
  }
});

// ── Admin: Approve a pending submission ─────────────────────────────────────
app.put("/api/products/:id/approve", protect, restrictTo("admin"), async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }
    if (product.status !== "pending") {
      return res.status(400).json({ success: false, error: "Product is not in pending status" });
    }

    product.status = "live";
    product.isApproved = true;
    product.addedBy = "moderator";
    // Auto-assign target section based on price, UNLESS it's a creator product
    const priceVal = product.dealPrice || product.retailPrice || 0;
    if (product.source === "creator_hub" || product.isOfficial === false) {
      product.targetSection = "category_only";
    } else {
      product.targetSection = priceVal >= 100000 ? "deals_luxury" : "shop_general";
    }

    await product.save();

    console.log(`[AMBIENCE] ✅ Product approved: "${product.name}"`);

    return res.status(200).json({
      success: true,
      product,
      message: "Product approved and now live!",
    });
  } catch (error) {
    console.error("[AMBIENCE] ❌ Error approving product:", error.message);
    return res.status(500).json({ success: false, error: "Failed to approve product" });
  }
});

// ── Admin: Reject and delete a pending submission ───────────────────────────
app.delete("/api/products/:id/reject", protect, restrictTo("admin"), async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, error: "Product not found" });
    }

    const productName = product.name;
    await Product.findByIdAndDelete(req.params.id);

    console.log(`[AMBIENCE] ❌ Product rejected: "${productName}"`);

    return res.status(200).json({
      success: true,
      message: "Product rejected and removed successfully.",
    });
  } catch (error) {
    console.error("[AMBIENCE] ❌ Error rejecting product:", error.message);
    return res.status(500).json({ success: false, error: "Failed to reject product" });
  }
});

app.put('/api/products/:id/approve-deals', protect, restrictTo('admin'), async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    if (product.status !== 'pending_deals_approval') {
      return res.status(400).json({ success: false, message: 'Product is not pending deals approval' });
    }

    // Approve: set live status while keeping category as 'Deals Page'
    product.status = 'live';
    product.isApproved = true;
    product.targetSection = 'deals_luxury';
    await product.save();

    console.log(`[AMBIENCE] 👑 Deals product approved: "${product.name}" → Royal Vault`);
    res.json({ success: true, message: 'Product approved to Deals Vault', product });
  } catch (err) {
    console.error('[Deals Approve]', err);
    res.status(500).json({ success: false, message: 'Failed to approve deals product' });
  }
});

app.get("/api/flagship", async (req, res) => {
  try {
    const deal = await FlagshipDeal.findOne();
    return res.status(200).json({ success: true, deal });
  } catch (error) {
    console.error("[AMBIENCE] ❌ Error fetching flagship deal:", error.message);
    return res.status(500).json({ success: false, error: "Failed to fetch flagship deal" });
  }
});

// ── Admin: Update flagship deal (PROTECTED) ────────────────────────────────
app.put("/api/flagship", protect, requireAdmin, async (req, res) => {
  try {
    const { title, subtitle, price, glyph, specs, imageUrl, modelUrl, isActive } = req.body;
    const deal = await FlagshipDeal.findOneAndUpdate({}, 
      { title, subtitle, price, glyph, specs, imageUrl, modelUrl, isActive, updatedAt: new Date() },
      { upsert: true, new: true, runValidators: true }
    );
    console.log(`[AMBIENCE] ✅ Flagship deal updated by ${req.user?.email}`);
    return res.status(200).json({ success: true, deal, message: "Flagship deal saved." });
  } catch (error) {
    console.error("[AMBIENCE] ❌ Error upserting flagship deal:", error.message);
    return res.status(500).json({ success: false, error: "Failed to save flagship deal" });
  }
});

// ─── Pro Plan Subscription ─────────────────────────────────────────────────
app.post('/api/subscription/pro/activate', protect, async (req, res) => {
  try {
    const User = require('./models/User');
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const now = new Date();
    user.proSubscription = {
      isActive: true,
      plan: 'monthly',
      priceINR: 4999,
      subscribedAt: now,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      razorpaySubId: req.body.razorpaySubId || null,
    };
    await user.save({ validateBeforeSave: false });

    res.json({
      message: 'Pro Plan activated successfully',
      proSubscription: user.proSubscription,
      isProMember: user.isProMember,
    });
  } catch (err) {
    console.error('[Pro Activate]', err);
    res.status(500).json({ message: 'Failed to activate Pro Plan' });
  }
});

app.get('/api/subscription/pro/status', protect, async (req, res) => {
  try {
    const User = require('./models/User');
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({
      proSubscription: user.proSubscription,
      isProMember: user.isProMember,
    });
  } catch (err) {
    console.error('[Pro Status]', err);
    res.status(500).json({ message: 'Failed to fetch Pro status' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5: Photo Processing Endpoint (kept inline — not auth-related)
// ═══════════════════════════════════════════════════════════════════════════════
const getLogoPath = () => {
  const logoExtensions = [".png", ".jpg", ".jpeg", ".webp", ".svg"];
  for (const ext of logoExtensions) {
    const logoPath = path.join(__dirname, "assets", `ambience-logo${ext}`);
    const fs = require("fs");
    if (fs.existsSync(logoPath)) return logoPath;
  }
  return null;
};

const photoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many photo uploads. Please try again later." },
});

app.post("/api/process-photo", photoLimiter, upload.single("photo"), async (req, res) => {
  const { email, service, notes } = req.body;

  if (!email || !req.file) {
    return res.status(400).json({
      success: false,
      error: "Email and photo are required.",
    });
  }

  try {
    const photoBase64 = req.file.buffer.toString("base64");
    const photoDataUri = `data:${req.file.mimetype};base64,${photoBase64}`;

    const logoPath = getLogoPath();
    const logoUrl = logoPath ? "cid:ambience-logo" : null;

    const htmlContent = generatePhotoFeedbackEmail({
      photoDataUri,
      service: service || "General Styling",
      notes: notes || "",
      email,
      logoUrl,
    });

    if (isEmailConfigured()) {
      await sendServiceEmail({
        to: email,
        subject: "✨ Your AMBIENCE Style Feedback is Ready",
        html: htmlContent,
        logLabel: 'Photo Feedback',
      });
    } else {
      console.log(`[AMBIENCE] 📸 Photo Feedback for ${email} (dev mode — email logged)`);
    }

    return res.status(200).json({
      success: true,
      message: "Photo processed successfully. Detailed feedback has been sent to your email.",
    });
  } catch (err) {
    console.error("[AMBIENCE] ❌ Error processing photo:", err.message);
    return res.status(500).json({
      success: false,
      error: "Failed to process photo. Please try again.",
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 6: Health Check
// ═══════════════════════════════════════════════════════════════════════════════
app.get("/api/health", (req, res) => {
  const dbStates = ["disconnected", "connected", "connecting", "disconnecting"];
  res.status(200).json({
    status: "ok",
    service: "AMBIENCE Authentication & Service Engine v3.0",
    database: dbStates[mongoose.connection.readyState] || "unknown",
    smtp: isEmailConfigured() ? "configured" : "dev-mode",
    timestamp: new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NEW ROUTES: Admin Stats, Orders & Invoice
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/stats', protect, requireAdmin, async (req, res) => {
  try {
    const revenueResult = await Order.aggregate([
      { $match: { paymentStatus: 'Success' } },
      { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' }, orderCount: { $sum: 1 } } }
    ]);
    const totalRevenue = revenueResult[0]?.totalRevenue || 0;
    const totalOrders = revenueResult[0]?.orderCount || 0;
    const liveProducts = await Product.countDocuments({ status: 'live' });
    const pendingProducts = await Product.countDocuments({ status: 'pending' });
    const totalProducts = await Product.countDocuments({});
    const ordersByStatus = await Order.aggregate([
      { $group: { _id: '$orderStatus', count: { $sum: 1 } } }
    ]);
    const recentOrders = await Order.find().sort({ createdAt: -1 }).limit(20)
      .select('orderId userEmail items amount totalAmount orderStatus paymentStatus shippingAddress createdAt invoiceNumber');
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30*24*60*60*1000);
    const sixtyDaysAgo = new Date(now - 60*24*60*60*1000);
    const recentProds = await Product.countDocuments({ createdAt: { $gte: thirtyDaysAgo }, status: 'live' });
    const prevProds = await Product.countDocuments({ createdAt: { $gte: sixtyDaysAgo, $lt: thirtyDaysAgo }, status: 'live' });
    const productGrowth = prevProds > 0 ? ((recentProds - prevProds) / prevProds * 100).toFixed(1) : recentProds > 0 ? '100.0' : '0.0';
    console.log(`[AMBIENCE] ✅ Admin stats fetched by ${req.user?.email}`);
    return res.status(200).json({ success: true, stats: { totalRevenue, totalOrders, liveProducts, pendingProducts, totalProducts, productGrowth, ordersByStatus: ordersByStatus.reduce((a, i) => { a[i._id] = i.count; return a; }, {}), recentOrders } });
  } catch (error) {
    console.error('[AMBIENCE] ❌ Error fetching admin stats:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch admin stats' });
  }
});

app.get('/api/admin/orders', protect, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const status = req.query.status;
    const skip = (page - 1) * limit;
    const filter = {};
    if (status) filter.orderStatus = status;
    const [orders, total] = await Promise.all([
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('user', 'name email phone'),
      Order.countDocuments(filter)
    ]);
    console.log(`[AMBIENCE] ✅ Admin fetched ${orders.length} orders (page ${page})`);
    return res.status(200).json({ success: true, orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    console.error('[AMBIENCE] ❌ Error fetching admin orders:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch orders' });
  }
});

app.put('/api/admin/orders/:id/status', protect, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['Confirmed', 'Processing', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled'];
    if (!valid.includes(status)) return res.status(400).json({ success: false, error: `Invalid status. Must be: ${valid.join(', ')}` });
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    order.orderStatus = status;
    await order.save();
    console.log(`[AMBIENCE] ✅ Order ${order.orderId} status → ${status} by ${req.user?.email}`);
    return res.status(200).json({ success: true, order, message: `Order status updated to ${status}` });
  } catch (error) {
    console.error('[AMBIENCE] ❌ Error updating order status:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to update order status' });
  }
});

app.get('/api/orders/:orderId/invoice', protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId).populate('user', 'name email phone');
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    const isOwner = order.user?._id?.toString() === req.user?._id?.toString();
    const isAdmin = req.user?.role === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ success: false, error: 'Not authorized' });
    if (!order.invoiceNumber && order.paymentStatus === 'Success') {
      const d = new Date().toISOString().slice(0,10).replace(/-/g,'');
      order.invoiceNumber = `AMB-${d}-${Math.random().toString(36).substring(2,7).toUpperCase()}`;
      order.invoiceDate = new Date();
      await order.save();
    }
    const invoice = {
      invoiceNumber: order.invoiceNumber || 'PENDING',
      invoiceDate: order.invoiceDate || order.paidAt || order.createdAt,
      orderId: order.orderId,
      customer: { name: order.user?.name || 'Customer', email: order.userEmail || order.user?.email || '', phone: order.user?.phone || '' },
      items: order.items.map(i => ({ name: i.name, brand: i.brand || '', category: i.category || '', qty: i.qty, price: i.priceINR, total: i.priceINR * i.qty })),
      subtotal: order.amount, tax: order.taxAmount, total: order.totalAmount,
      currency: order.currency || 'INR', paymentMethod: 'Razorpay', paymentId: order.razorpay_payment_id || '',
      shippingAddress: order.shippingAddress, orderStatus: order.orderStatus, paymentStatus: order.paymentStatus
    };
    console.log(`[AMBIENCE] ✅ Invoice ${invoice.invoiceNumber} fetched`);
    return res.status(200).json({ success: true, invoice });
  } catch (error) {
    console.error('[AMBIENCE] ❌ Error generating invoice:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to generate invoice' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 7: 404 Fallback
// ═══════════════════════════════════════════════════════════════════════════════
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.originalUrl} not found.`,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 7b: Global Error Handler
//
// Without this, any unhandled throw (Mongoose timeout, validation error, etc.)
// triggers Express's default HTML error page. The browser, expecting JSON from
// a cross-origin fetch, interprets the HTML as a CORS/Network failure.
// This middleware ensures ALL errors return structured JSON.
// ═══════════════════════════════════════════════════════════════════════════════
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  // CORS rejection from the origin callback above
  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({
      success: false,
      error: "Origin not allowed by CORS policy.",
    });
  }

  // Mongoose / MongoDB errors
  if (err.name === "MongooseError" || err.name === "MongoServerError" || err.name === "MongoError") {
    console.error("[Global Error Handler] Database error:", err.message);
    return res.status(500).json({
      success: false,
      error: "A database error occurred. Please try again later.",
    });
  }

  // Catch-all
  console.error("[Global Error Handler] Unhandled error:", err.stack || err.message);
  return res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === "production"
      ? "An unexpected error occurred. Please try again."
      : err.message,
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 8: Start Server (only AFTER MongoDB connects)
// ═══════════════════════════════════════════════════════════════════════════════
const startServer = async () => {
  // Connect to MongoDB Atlas first
  await connectDB();

  // Start listening
  app.listen(PORT, () => {
    console.log("");
    console.log("══════════════════════════════════════════════════════════");
    console.log("  🚀  AMBIENCE Server v3.0 — MongoDB Atlas Edition");
    console.log("══════════════════════════════════════════════════════════");
    console.log(`  🌐  Server:     ${SERVER_URL}`);
    console.log(`  🗄️   Database:   MongoDB Atlas (${mongoose.connection.name})`);
    console.log(`  🔐  Auth API:   ${SERVER_URL}/api/auth/*`);
    console.log(`  📸  Photo API:  ${SERVER_URL}/api/process-photo`);
    console.log(`  🖼️   Assets:     ${SERVER_URL}/assets/`);
    console.log(`  💚  Health:     ${SERVER_URL}/api/health`);
    console.log(`  💳  Razorpay:   ${process.env.RAZORPAY_KEY_ID ? "Test Mode (" + process.env.RAZORPAY_KEY_ID.substring(0, 12) + "...)" : "⚠️  Not configured"}`);
    console.log(`  📧  SMTP:       ${isEmailConfigured() ? "Gmail (" + GMAIL_USER + ")" : "⚠️  Not configured (dev mode)"}`);
    console.log("══════════════════════════════════════════════════════════");
    console.log("");
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 9: Graceful Shutdown
// ═══════════════════════════════════════════════════════════════════════════════
const gracefulShutdown = async (signal) => {
  console.log(`\n[AMBIENCE] ${signal} received. Shutting down gracefully...`);
  try {
    await mongoose.connection.close();
    console.log("[AMBIENCE] MongoDB connection closed.");
  } catch (err) {
    console.error("[AMBIENCE] Error closing MongoDB:", err.message);
  }
  process.exit(0);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

// ── Launch ──────────────────────────────────────────────────────────────────
startServer().catch((err) => {
  console.error("[AMBIENCE] ❌ Fatal startup error:", err.message);
  process.exit(1);
});
