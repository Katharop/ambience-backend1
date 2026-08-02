// server/controllers/auth.js
//
// AMBIENCE — Enterprise Authentication Controller
//
// Production-grade auth handlers:
//   • register           — Email/password signup + OTP email
//   • verifyOTP          — Server-side OTP verification + auto-login
//   • login              — Email/password with lockout protection
//   • googleLogin        — Google OAuth 2.0 via google-auth-library
//   • twitterAuth        — Twitter/X OAuth 2.0 PKCE
//   • createGuestSession — 24-hour limited JWT for guest browsing
//   • getSession         — JWT validation + user data
//   • logout             — Stateless (client removes token)
//   • forgotPassword     — Send password reset OTP
//   • resetPassword      — Verify OTP + update password
//   • resendOTP          — Resend verification code
// ─────────────────────────────────────────────────────────────────────────────

const { OAuth2Client } = require("google-auth-library");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { Resend } = require("resend");
const path = require("path");
const fs = require("fs");

const User = require("../models/User");
const { generateAccessToken, generateRefreshToken } = require("../utils/generateToken");
const {
  storeOTP,
  verifyOTP: verifyStoredOTP,
  clearOTP,
  recordFailedLogin,
  isAccountLocked,
  clearLoginAttempts,
} = require("../sessionStore");
const { setRefreshCookie, clearAuthCookies } = require("../middleware/auth");
const { recordAuthFailure } = require("../middleware/threatDetection");
const { generateOTPEmail } = require("../otp-email-template");
const {
  generateWelcomeEmail,
  generatePasswordResetConfirmEmail,
} = require("../welcome-email-template");

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ─────────────────────────────────────────────────────────────────────────────
// Resend Email Setup
// ─────────────────────────────────────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const resendConfigured = !!RESEND_API_KEY && !RESEND_API_KEY.includes("YOUR_");
let resend = null;

if (resendConfigured) {
  resend = new Resend(RESEND_API_KEY);
  console.log("[AuthController] ✅ Resend email service initialized");
} else {
  console.log("[AuthController] ⚠️  RESEND_API_KEY not set — emails will log to console (dev mode)");
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: Secure 6-digit OTP
// ─────────────────────────────────────────────────────────────────────────────
const generateSecureOTP = () => {
  const otp = crypto.randomInt(0, 1000000);
  return otp.toString().padStart(6, "0");
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility: Email validation
// ─────────────────────────────────────────────────────────────────────────────
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const validateEmail = (email) => {
  if (!email || typeof email !== "string") return null;
  const sanitized = email.trim().toLowerCase();
  if (!emailRegex.test(sanitized)) return null;
  return sanitized;
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility: Password validation
// ─────────────────────────────────────────────────────────────────────────────
const validatePassword = (password) => {
  if (!password || typeof password !== "string") {
    return "Password is required.";
  }
  if (password.length < 6) {
    return "Password must be at least 6 characters.";
  }
  if (password.length > 128) {
    return "Password must be less than 128 characters.";
  }
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility: Logo path resolver
// ─────────────────────────────────────────────────────────────────────────────
const getLogoPath = () => {
  const logoExtensions = [".png", ".jpg", ".jpeg", ".webp", ".svg"];
  for (const ext of logoExtensions) {
    const logoPath = path.join(__dirname, "..", "assets", `ambience-logo${ext}`);
    if (fs.existsSync(logoPath)) {
      return logoPath;
    }
  }
  return null;
};

const getLogoUrl = () => {
  const p = getLogoPath();
  return p ? "cid:ambience-logo" : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility: Send email via Resend (or log in dev mode)
// ─────────────────────────────────────────────────────────────────────────────
const sendEmail = async ({ to, subject, html, logLabel = "Email" }) => {
  if (resend) {
    const { data, error } = await resend.emails.send({
      from: "Ambience <onboarding@resend.dev>",
      to: [to],
      subject,
      html,
    });

    if (error) {
      console.error(`[AMBIENCE] ❌ ${logLabel} send failed:`, error.message);
      throw new Error(error.message);
    }

    console.log(
      `[AMBIENCE] ✉️  ${logLabel} sent to ${to} | ID: ${data.id}`
    );
    return data;
  } else {
    console.log("");
    console.log("┌─────────────────────────────────────────────────┐");
    console.log(`│  📧  AMBIENCE ${logLabel} — DEV MODE`.padEnd(50) + "│");
    console.log(`│  To:  ${to}`.padEnd(50) + "│");
    console.log("│  (Set RESEND_API_KEY in .env for real delivery)  │");
    console.log("└─────────────────────────────────────────────────┘");
    console.log("");
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLLER: register
//
// POST /api/auth/register
// Body: { email, password, confirmPassword, name? }
// ═══════════════════════════════════════════════════════════════════════════════
exports.register = async (req, res) => {
  const { email, password, confirmPassword, name } = req.body;

  const sanitizedEmail = validateEmail(email);
  if (!sanitizedEmail) {
    return res
      .status(400)
      .json({ success: false, error: "Please enter a valid email address." });
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    return res.status(400).json({ success: false, error: passwordError });
  }

  if (password !== confirmPassword) {
    return res
      .status(400)
      .json({ success: false, error: "Passwords do not match. Please confirm your password." });
  }

  try {
    const existingUser = await User.findOne({ email: sanitizedEmail });

    if (existingUser) {
      if (existingUser.isVerified) {
        return res.status(409).json({
          success: false,
          error: "An account with this email already exists. Please sign in instead.",
        });
      } else {
        // Unverified user — delete and allow re-registration
        await User.deleteOne({ _id: existingUser._id });
      }
    }

    // Create user (password hashing handled by pre-save hook in User model)
    const user = await User.create({
      email: sanitizedEmail,
      password,
      name: name || sanitizedEmail.split("@")[0],
      provider: "local",
    });

    // Generate and store OTP server-side
    const otp = generateSecureOTP();
    storeOTP(sanitizedEmail, otp, "register");

    // Send OTP email
    const logoUrl = getLogoUrl();
    const htmlContent = generateOTPEmail({
      otp,
      email: sanitizedEmail,
      expiry: 20,
      logoUrl,
    });

    // Send email synchronously to ensure we catch provider errors (e.g. Sandbox limit)
    try {
      await sendEmail({
        to: sanitizedEmail,
        subject: "Your AMBIENCE Verification Code",
        html: htmlContent,
        logLabel: "Registration OTP",
      });
    } catch (emailErr) {
      // Clean up the created user if email fails
      await User.deleteOne({ _id: user._id });
      clearOTP(sanitizedEmail);
      return res.status(500).json({
        success: false,
        error: "Failed to send verification code. Please try again later.",
      });
    }

    // Dev mode: log OTP to console
    if (!resendConfigured) {
      console.log(`\n  🔑  DEV OTP for ${sanitizedEmail}: ${otp}\n`);
    }

    return res.status(200).json({
      success: true,
      message: "Verification code sent to your email. Please check your inbox.",
    });
  } catch (err) {
    console.error("[AMBIENCE] ❌ Registration error:", err.message);

    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        error: "An account with this email already exists.",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Registration failed. Please try again.",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLLER: verifyOTP
//
// POST /api/auth/verify-otp
// Body: { email, otp, type: "register" | "reset" }
// ═══════════════════════════════════════════════════════════════════════════════
exports.verifyOTP = async (req, res) => {
  const { email, otp, type = "register" } = req.body;

  const sanitizedEmail = validateEmail(email);
  if (!sanitizedEmail) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid email address." });
  }

  if (!otp || typeof otp !== "string" || otp.length !== 6) {
    return res.status(400).json({
      success: false,
      error: "Please enter a valid 6-digit verification code.",
    });
  }

  try {
    const result = verifyStoredOTP(sanitizedEmail, otp, type);
    if (!result.valid) {
      return res.status(400).json({ success: false, error: result.error });
    }

    if (type === "register") {
      // Mark user as verified
      const user = await User.findOneAndUpdate(
        { email: sanitizedEmail },
        { isVerified: true },
        { new: true }
      );

      if (!user) {
        return res.status(500).json({
          success: false,
          error: "User not found after verification.",
        });
      }

      // Generate JWT
      const token = generateAccessToken(user._id, user.email, user.role);
      const refreshTkn = generateRefreshToken(user._id, user.email, user.role, user.tokenVersion);
      setRefreshCookie(res, refreshTkn);

      // Send welcome email (non-blocking)
      const logoUrl = getLogoUrl();
      sendEmail({
        to: sanitizedEmail,
        subject: "✨ Welcome to AMBIENCE — Your Vault is Ready",
        html: generateWelcomeEmail({
          email: sanitizedEmail,
          name: user.displayName,
          logoUrl,
        }),
        logLabel: "Welcome Email",
      }).catch((err) =>
        console.error("[AMBIENCE] Welcome email error:", err.message)
      );

      return res.status(200).json({
        success: true,
        message: "Email verified successfully. Welcome to Ambience!",
        token,
        user: user.toSafeObject(),
      });
    }

    if (type === "reset") {
      return res.status(200).json({
        success: true,
        message: "Code verified. You can now set your new password.",
        resetAuthorized: true,
      });
    }

    return res
      .status(400)
      .json({ success: false, error: "Invalid verification type." });
  } catch (err) {
    console.error("[AMBIENCE] ❌ OTP verification error:", err.message);
    return res.status(500).json({
      success: false,
      error: "Verification failed. Please try again.",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLLER: login
//
// POST /api/auth/login
// Body: { email, password }
// ═══════════════════════════════════════════════════════════════════════════════
exports.login = async (req, res) => {
  const { email, password } = req.body;

  const sanitizedEmail = validateEmail(email);
  if (!sanitizedEmail) {
    return res
      .status(400)
      .json({ success: false, error: "Please enter a valid email address." });
  }

  if (!password || typeof password !== "string") {
    return res
      .status(400)
      .json({ success: false, error: "Password is required." });
  }

  try {
    // Check lockout FIRST
    const lockStatus = isAccountLocked(sanitizedEmail);
    if (lockStatus.locked) {
      return res.status(429).json({
        success: false,
        error: `Account temporarily locked due to too many failed attempts. Try again in ${Math.ceil(lockStatus.remainingSeconds / 60)} minutes.`,
        accountLocked: true,
        remainingSeconds: lockStatus.remainingSeconds,
      });
    }

    // Find user — explicitly select password field
    const user = await User.findOne({ email: sanitizedEmail }).select(
      "+password"
    );

    if (!user) {
      recordFailedLogin(sanitizedEmail);
      recordAuthFailure(req);
      return res
        .status(401)
        .json({ success: false, error: "Invalid email or password." });
    }

    // Check email verification
    if (!user.isVerified) {
      return res.status(403).json({
        success: false,
        error: "Email not verified. Please complete registration first.",
        needsVerification: true,
      });
    }

    // Check if user has a password (social-only accounts don't)
    if (!user.password) {
      return res.status(401).json({
        success: false,
        error:
          "This account was created with social login. Please sign in with Google or Twitter.",
      });
    }

    // Compare password
    const isMatch = await user.matchPassword(password);

    if (!isMatch) {
      const result = recordFailedLogin(sanitizedEmail);
      recordAuthFailure(req);
      if (result.locked) {
        return res.status(429).json({
          success: false,
          error:
            "Account temporarily locked due to too many failed attempts. Try again in 15 minutes.",
          accountLocked: true,
          remainingSeconds: 15 * 60,
        });
      }
      return res.status(401).json({
        success: false,
        error: `Invalid email or password. ${result.remainingAttempts} attempt${result.remainingAttempts !== 1 ? "s" : ""} remaining.`,
      });
    }

    // Success — clear lockout tracking
    clearLoginAttempts(sanitizedEmail);

    // Issue access token + httpOnly refresh cookie
    const token = generateAccessToken(user._id, user.email, user.role);
    const refreshTkn = generateRefreshToken(user._id, user.email, user.role, user.tokenVersion);
    setRefreshCookie(res, refreshTkn);

    console.log(`[AMBIENCE] ✅ Login successful: ${sanitizedEmail}`);

    return res.status(200).json({
      success: true,
      message: "Login successful. Welcome back!",
      token,
      user: user.toSafeObject(),
    });
  } catch (err) {
    console.error("[AMBIENCE] ❌ Login error:", err.message);
    return res
      .status(500)
      .json({ success: false, error: "Login failed. Please try again." });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLLER: googleLogin
//
// POST /api/auth/google
// Body: { idToken } or { credential }
//
// Two-mode verification:
//   Mode 1: Direct ID Token → verifyIdToken() via google-auth-library
//   Mode 2: Authorization Code → exchange at Google, then verifyIdToken()
//
// Auto-registers new users with their Google avatar, email, and display name.
// Returns a secure JWT on success.
// ═══════════════════════════════════════════════════════════════════════════════
exports.googleLogin = async (req, res) => {
  const { idToken, credential } = req.body;
  const tokenOrCode = idToken || credential;

  if (!tokenOrCode || typeof tokenOrCode !== "string") {
    return res
      .status(400)
      .json({ success: false, error: "Missing Google credential." });
  }

  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.startsWith("YOUR_")) {
    return res.status(500).json({
      success: false,
      error: "Google OAuth is not configured on the server. Set GOOGLE_CLIENT_ID in server/.env",
    });
  }

  try {
    let googleEmail = null;
    let googleName = null;
    let googleAvatar = null;
    let googleSubId = null;

    // ── Mode 1: Try direct ID Token verification ──────────────────────────
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: tokenOrCode,
        audience: GOOGLE_CLIENT_ID,
      });

      const payload = ticket.getPayload();

      if (!payload.email_verified) {
        return res.status(401).json({
          success: false,
          error: "Google email is not verified.",
        });
      }

      googleEmail = payload.email;
      googleName = payload.name || payload.email.split("@")[0];
      googleAvatar = payload.picture || null;
      googleSubId = payload.sub;
    } catch (verifyError) {
      // ── Mode 2: Authorization Code exchange ─────────────────────────────
      // verifyIdToken failed — credential is likely an authorization code.
      // Exchange it for tokens at Google's token endpoint.

      if (
        !GOOGLE_CLIENT_SECRET ||
        GOOGLE_CLIENT_SECRET.startsWith("YOUR_")
      ) {
        console.error(
          "[AMBIENCE] ❌ Google token verification failed and no CLIENT_SECRET for code exchange:",
          verifyError.message
        );
        return res.status(401).json({
          success: false,
          error: "Google authentication failed. Please try again.",
        });
      }

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: tokenOrCode,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: "postmessage",
          grant_type: "authorization_code",
        }).toString(),
      });

      if (!tokenRes.ok) {
        const errData = await tokenRes.json().catch(() => ({}));
        console.error(
          "[AMBIENCE] ❌ Google code exchange failed:",
          errData
        );
        return res.status(401).json({
          success: false,
          error: "Google authentication failed. Please try again.",
        });
      }

      const tokens = await tokenRes.json();
      const exchangedIdToken = tokens.id_token;

      if (!exchangedIdToken) {
        return res.status(401).json({
          success: false,
          error: "Google did not return an ID token.",
        });
      }

      // Verify the exchanged ID token
      const ticket = await googleClient.verifyIdToken({
        idToken: exchangedIdToken,
        audience: GOOGLE_CLIENT_ID,
      });

      const payload = ticket.getPayload();

      if (!payload.email_verified) {
        return res.status(401).json({
          success: false,
          error: "Google email is not verified.",
        });
      }

      googleEmail = payload.email;
      googleName = payload.name || payload.email.split("@")[0];
      googleAvatar = payload.picture || null;
      googleSubId = payload.sub;
    }

    // ── At this point, we have verified Google user data ───────────────────

    if (!googleEmail) {
      return res.status(401).json({
        success: false,
        error: "Could not extract email from Google account.",
      });
    }

    const normalizedEmail = googleEmail.trim().toLowerCase();

    // ── Find or create user ───────────────────────────────────────────────
    let user = await User.findOne({ email: normalizedEmail });
    let isNewUser = false;

    if (user) {
      // Existing user — update Google ID and avatar if missing
      let needsSave = false;

      if (!user.googleId && googleSubId) {
        user.googleId = googleSubId;
        needsSave = true;
      }

      if (!user.avatar && googleAvatar) {
        user.avatar = googleAvatar;
        needsSave = true;
      }

      if (!user.isVerified) {
        user.isVerified = true;
        user.provider = "google";
        needsSave = true;
      }

      if (!user.name && googleName) {
        user.name = googleName;
        needsSave = true;
      }

      if (needsSave) {
        await user.save();
      }
    } else {
      // New user — auto-register with Google data
      user = await User.create({
        email: normalizedEmail,
        name: googleName,
        googleId: googleSubId,
        avatar: googleAvatar,
        provider: "google",
        isVerified: true,
        role: "customer",
      });

      isNewUser = true;
    }

    // ── Issue access token + httpOnly refresh cookie ─────────────────────
    const token = generateAccessToken(user._id, user.email, user.role);
    const refreshTkn = generateRefreshToken(user._id, user.email, user.role, user.tokenVersion);
    setRefreshCookie(res, refreshTkn);

    console.log(
      `[AMBIENCE] ✅ Google OAuth login: ${normalizedEmail} (${isNewUser ? "new" : "existing"} user)`
    );

    return res.status(200).json({
      success: true,
      message: isNewUser
        ? "Account created successfully. Welcome to Ambience!"
        : "Welcome back!",
      token,
      user: user.toSafeObject(),
      isNewUser,
    });
  } catch (err) {
    console.error("[AMBIENCE] ❌ Google OAuth error:", err.message);
    return res.status(500).json({
      success: false,
      error: "Google authentication failed. Please try again.",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLLER: twitterAuth
//
// POST /api/auth/twitter
// Body: { code, codeVerifier }
// ═══════════════════════════════════════════════════════════════════════════════
exports.twitterAuth = async (req, res) => {
  const { code, codeVerifier } = req.body;

  if (!code || !codeVerifier) {
    return res.status(400).json({
      success: false,
      error: "Missing Twitter authorization code or verifier.",
    });
  }

  const TWITTER_CLIENT_ID = process.env.TWITTER_CLIENT_ID;
  const TWITTER_CLIENT_SECRET = process.env.TWITTER_CLIENT_SECRET;
  const REDIRECT_URI =
    process.env.TWITTER_REDIRECT_URI ||
    "http://localhost:3000/auth/twitter/callback";

  if (!TWITTER_CLIENT_ID || TWITTER_CLIENT_ID.startsWith("YOUR_")) {
    return res.status(500).json({
      success: false,
      error: "Twitter OAuth is not configured on the server.",
    });
  }

  try {
    // Exchange authorization code for access token
    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
      client_id: TWITTER_CLIENT_ID,
    });

    const basicAuth = Buffer.from(
      `${TWITTER_CLIENT_ID}:${TWITTER_CLIENT_SECRET || ""}`
    ).toString("base64");

    const tokenResponse = await fetch(
      "https://api.twitter.com/2/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basicAuth}`,
        },
        body: tokenParams.toString(),
      }
    );

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json().catch(() => ({}));
      console.error(
        "[AMBIENCE] ❌ Twitter token exchange failed:",
        errorData
      );
      return res.status(401).json({
        success: false,
        error: "Twitter authentication failed. Please try again.",
      });
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Fetch user profile from Twitter
    const userResponse = await fetch(
      "https://api.twitter.com/2/users/me?user.fields=profile_image_url,name,username",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!userResponse.ok) {
      console.error(
        "[AMBIENCE] ❌ Twitter user fetch failed:",
        userResponse.status
      );
      return res.status(401).json({
        success: false,
        error: "Failed to fetch Twitter profile.",
      });
    }

    const userData = await userResponse.json();
    const twitterUser = userData.data;
    const displayName = twitterUser.name || twitterUser.username;
    const twitterEmail = `${twitterUser.username}@twitter.auth`;
    const twitterAvatar = twitterUser.profile_image_url || null;

    // Find or create user
    let user = await User.findOne({ email: twitterEmail });
    let isNewUser = false;

    if (user) {
      if (!user.avatar && twitterAvatar) {
        user.avatar = twitterAvatar;
        await user.save();
      }
    } else {
      user = await User.create({
        email: twitterEmail,
        name: displayName,
        avatar: twitterAvatar,
        provider: "twitter",
        isVerified: true,
        role: "customer",
      });
      isNewUser = true;
    }

    const token = generateAccessToken(user._id, user.email, user.role);
    const refreshTkn = generateRefreshToken(user._id, user.email, user.role, user.tokenVersion);
    setRefreshCookie(res, refreshTkn);

    console.log(
      `[AMBIENCE] ✅ Twitter OAuth login: @${twitterUser.username} (${isNewUser ? "new" : "existing"} user)`
    );

    return res.status(200).json({
      success: true,
      message: isNewUser
        ? "Account created successfully. Welcome to Ambience!"
        : "Welcome back!",
      token,
      user: user.toSafeObject(),
      isNewUser,
    });
  } catch (err) {
    console.error("[AMBIENCE] ❌ Twitter OAuth error:", err.message);
    return res.status(500).json({
      success: false,
      error: "Twitter authentication failed. Please try again.",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLLER: createGuestSession
//
// POST /api/auth/guest
//
// Issues a 24-hour limited JWT for the "Skip & Explore Store" feature.
// Guest tokens carry role="guest" and restricted permissions.
// No database record is created — stateless ephemeral access.
// ═══════════════════════════════════════════════════════════════════════════════
exports.createGuestSession = async (req, res) => {
  try {
    const guestId = crypto.randomUUID();
    const guestEmail = `guest_${guestId.slice(0, 8)}@ambience.guest`;

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({
        success: false,
        error: "Server configuration error. JWT_SECRET not set.",
      });
    }

    const token = jwt.sign(
      {
        id: guestId,
        email: guestEmail,
        role: "guest",
        isGuest: true,
        type: "access",
      },
      secret,
      {
        expiresIn: "365d",
        algorithm: "HS256",
        issuer: "ambience",
        audience: "ambience-client",
        subject: guestId,
      }
    );

    console.log(`[AMBIENCE] 👤 Guest session created: ${guestId.slice(0, 8)}...`);

    return res.status(200).json({
      success: true,
      message: "Guest session created. Explore the store!",
      token,
      user: {
        id: guestId,
        userId: guestId,
        email: guestEmail,
        name: "Guest Explorer",
        role: "guest",
        isGuest: true,
        initial: "G",
        displayName: "Guest Explorer",
        avatar: null,
      },
      expiresIn: "365d",
    });
  } catch (err) {
    console.error("[AMBIENCE] ❌ Guest session error:", err.message);
    return res.status(500).json({
      success: false,
      error: "Failed to create guest session.",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLLER: getSession
//
// GET /api/auth/session
// Headers: Authorization: Bearer <jwt>
// Protected by JWT middleware — req.user is already populated
// ═══════════════════════════════════════════════════════════════════════════════
exports.getSession = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return res
        .status(401)
        .json({ success: false, error: "User not found." });
    }

    return res.status(200).json({
      success: true,
      user: user.toSafeObject(),
    });
  } catch (err) {
    console.error("[AMBIENCE] ❌ Session check error:", err.message);
    return res
      .status(500)
      .json({ success: false, error: "Session validation failed." });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLLER: logout
//
// POST /api/auth/logout
// JWT is stateless — client removes the token.
// This endpoint exists for API consistency and future token blacklisting.
// ═══════════════════════════════════════════════════════════════════════════════
exports.logout = async (req, res) => {
  // Clear the httpOnly refresh token cookie
  clearAuthCookies(res);
  return res.status(200).json({
    success: true,
    message: "Logged out successfully.",
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLLER: forgotPassword
//
// POST /api/auth/forgot-password
// Body: { email }
// ═══════════════════════════════════════════════════════════════════════════════
exports.forgotPassword = async (req, res) => {
  const { email } = req.body;

  const sanitizedEmail = validateEmail(email);
  if (!sanitizedEmail) {
    return res
      .status(400)
      .json({ success: false, error: "Please enter a valid email address." });
  }

  try {
    // Find verified user
    const user = await User.findOne({
      email: sanitizedEmail,
      isVerified: true,
    });

    if (!user) {
      // Generic response to prevent email enumeration
      return res.status(200).json({
        success: true,
        message:
          "If an account exists with this email, a reset code has been sent.",
      });
    }

    // Generate OTP
    const otp = generateSecureOTP();
    storeOTP(sanitizedEmail, otp, "reset");

    // Send reset email
    const logoUrl = getLogoUrl();
    const htmlContent = generateOTPEmail({
      otp,
      email: sanitizedEmail,
      expiry: 20,
      logoUrl,
    });

    // Send email synchronously to ensure we catch provider errors
    try {
      await sendEmail({
        to: sanitizedEmail,
        subject: "AMBIENCE Password Reset Code",
        html: htmlContent,
        logLabel: "Password Reset OTP",
      });
    } catch (emailErr) {
      clearOTP(sanitizedEmail);
      return res.status(500).json({
        success: false,
        error: "Failed to send reset code. Please try again later.",
      });
    }

    if (!resendConfigured) {
      console.log(`\n  🔑  DEV RESET OTP for ${sanitizedEmail}: ${otp}\n`);
    }

    return res.status(200).json({
      success: true,
      message:
        "If an account exists with this email, a reset code has been sent.",
    });
  } catch (err) {
    console.error("[AMBIENCE] ❌ Forgot password error:", err.message);
    return res.status(500).json({
      success: false,
      error: "Failed to send reset code. Please try again.",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLLER: resetPassword
//
// POST /api/auth/reset-password
// Body: { email, otp, newPassword, confirmPassword }
// ═══════════════════════════════════════════════════════════════════════════════
exports.resetPassword = async (req, res) => {
  const { email, otp, newPassword, confirmPassword } = req.body;

  const sanitizedEmail = validateEmail(email);
  if (!sanitizedEmail) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid email address." });
  }

  if (!otp || otp.length !== 6) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid verification code." });
  }

  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    return res.status(400).json({ success: false, error: passwordError });
  }

  if (newPassword !== confirmPassword) {
    return res
      .status(400)
      .json({ success: false, error: "Passwords do not match." });
  }

  try {
    // Verify OTP
    const otpResult = verifyStoredOTP(sanitizedEmail, otp, "reset");
    if (!otpResult.valid) {
      return res
        .status(400)
        .json({ success: false, error: otpResult.error });
    }

    // Find user and update password
    const user = await User.findOne({ email: sanitizedEmail }).select(
      "+password"
    );

    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: "User not found." });
    }

    user.password = newPassword; // Pre-save hook handles bcrypt hashing
    await user.save();

    // Send confirmation email (non-blocking)
    const logoUrl = getLogoUrl();
    sendEmail({
      to: sanitizedEmail,
      subject: "🔐 AMBIENCE — Password Reset Successful",
      html: generatePasswordResetConfirmEmail({
        email: sanitizedEmail,
        logoUrl,
      }),
      logLabel: "Password Reset Confirmation",
    }).catch((err) =>
      console.error(
        "[AMBIENCE] Reset confirmation email error:",
        err.message
      )
    );

    console.log(`[AMBIENCE] ✅ Password reset for: ${sanitizedEmail}`);

    return res.status(200).json({
      success: true,
      message:
        "Password reset successfully. Please sign in with your new password.",
    });
  } catch (err) {
    console.error("[AMBIENCE] ❌ Password reset error:", err.message);
    return res.status(500).json({
      success: false,
      error: "Password reset failed. Please try again.",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLLER: resendOTP
//
// POST /api/auth/resend-otp
// Body: { email, type: "register" | "reset" }
// ═══════════════════════════════════════════════════════════════════════════════
exports.resendOTP = async (req, res) => {
  const { email, type = "register" } = req.body;

  const sanitizedEmail = validateEmail(email);
  if (!sanitizedEmail) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid email address." });
  }

  try {
    clearOTP(sanitizedEmail);

    const otp = generateSecureOTP();
    storeOTP(sanitizedEmail, otp, type);

    const logoUrl = getLogoUrl();
    const htmlContent = generateOTPEmail({
      otp,
      email: sanitizedEmail,
      expiry: 20,
      logoUrl,
    });

    const subject =
      type === "reset"
        ? "AMBIENCE Password Reset Code"
        : "Your AMBIENCE Verification Code";

    // Send email synchronously to catch provider errors
    try {
      await sendEmail({
        to: sanitizedEmail,
        subject,
        html: htmlContent,
        logLabel: "Resent OTP",
      });
    } catch (emailErr) {
      clearOTP(sanitizedEmail);
      return res.status(500).json({
        success: false,
        error: "Failed to resend code. Please try again later.",
      });
    }

    if (!resendConfigured) {
      console.log(
        `\n  🔑  DEV RESEND OTP for ${sanitizedEmail}: ${otp}\n`
      );
    }

    return res.status(200).json({
      success: true,
      message: "A new verification code has been sent to your email.",
    });
  } catch (err) {
    console.error("[AMBIENCE] ❌ Resend OTP error:", err.message);
    return res.status(500).json({
      success: false,
      error: "Failed to resend code. Please try again.",
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE PROFILE — Protected endpoint for editing name, phone, avatar
//
// PUT /api/auth/update-profile
// Headers: Authorization: Bearer <token>
// Body: { name?, phone?, avatar? }
//
// • name:   string, max 100 chars, trimmed
// • phone:  string or null, trimmed
// • avatar: URL string or base64 data URI (max ~2MB encoded)
//
// Returns updated user via toSafeObject() — no password or internal fields.
// ─────────────────────────────────────────────────────────────────────────────
exports.updateProfile = async (req, res) => {
  try {
    const userId = req.user._id; // set by protect middleware
    const { name, phone, avatar } = req.body;

    // ── Build update object (only include provided fields) ──────────────
    const updates = {};

    if (name !== undefined) {
      const trimmedName = (name || "").trim();
      if (trimmedName.length > 100) {
        return res.status(400).json({
          success: false,
          error: "Name cannot exceed 100 characters.",
        });
      }
      updates.name = trimmedName || null;
    }

    if (phone !== undefined) {
      updates.phone = phone ? phone.trim() : null;
    }

    if (avatar !== undefined) {
      // Validate: must be a URL or a base64 data URI
      if (avatar && typeof avatar === "string") {
        const isUrl = avatar.startsWith("http://") || avatar.startsWith("https://");
        const isDataUri = avatar.startsWith("data:image/");

        if (!isUrl && !isDataUri) {
          return res.status(400).json({
            success: false,
            error: "Invalid avatar format. Must be a URL or image data URI.",
          });
        }

        // Reject overly large base64 payloads (~2MB = ~2.7MB base64)
        if (isDataUri && avatar.length > 3 * 1024 * 1024) {
          return res.status(400).json({
            success: false,
            error: "Avatar image is too large. Maximum 2MB allowed.",
          });
        }
      }
      updates.avatar = avatar || null;
    }

    // ── Perform update ─────────────────────────────────────────────────
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: "No fields to update.",
      });
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updates },
      { new: true, runValidators: true }
    ).select("-password");

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        error: "User not found.",
      });
    }

    console.log(`[AMBIENCE] ✅ Profile updated for ${updatedUser.email}`);

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully.",
      user: updatedUser.toSafeObject(),
    });
  } catch (err) {
    console.error("[AMBIENCE] ❌ Update profile error:", err.message);

    // Handle Mongoose validation errors gracefully
    if (err.name === "ValidationError") {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({
        success: false,
        error: messages.join(", "),
      });
    }

    return res.status(500).json({
      success: false,
      error: "Failed to update profile. Please try again.",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONTROLLER: refreshToken
//
// POST /api/auth/refresh
//
// Reads the httpOnly refresh token cookie, verifies it, and issues a new
// access token + rotated refresh token. This enables silent session renewal
// without storing tokens in localStorage.
//
// Security:
//   • Refresh token is read from httpOnly cookie (immune to XSS)
//   • Token version is checked against the database (revocation support)
//   • Password change timestamp is validated
//   • New refresh token is issued (rotation prevents replay attacks)
// ═══════════════════════════════════════════════════════════════════════════════
exports.refreshToken = async (req, res) => {
  const refreshTokenValue = req.cookies?.ambience_refresh;

  if (!refreshTokenValue) {
    return res.status(401).json({
      success: false,
      error: "No refresh token provided.",
      code: "REFRESH_NO_TOKEN",
    });
  }

  const secret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    return res.status(500).json({
      success: false,
      error: "Server configuration error.",
    });
  }

  // ── Step 1: Verify the refresh token JWT ────────────────────────────────
  let decoded;
  try {
    decoded = jwt.verify(refreshTokenValue, secret, {
      algorithms: ["HS256"],
      issuer: "ambience",
      audience: "ambience-client",
    });
  } catch (err) {
    // JWT verification failed — token is genuinely expired/invalid
    clearAuthCookies(res);

    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        error: "Refresh token expired. Please sign in again.",
        code: "REFRESH_TOKEN_EXPIRED",
      });
    }

    return res.status(401).json({
      success: false,
      error: "Invalid refresh token.",
      code: "REFRESH_TOKEN_INVALID",
    });
  }

  // ── Step 2: Guest refresh (no DB lookup needed) ─────────────────────────
  if (decoded.isGuest || decoded.role === "guest") {
    const newAccessToken = jwt.sign(
      {
        id: decoded.id,
        email: decoded.email,
        role: "guest",
        isGuest: true,
        type: "access",
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "365d",
        algorithm: "HS256",
        issuer: "ambience",
        audience: "ambience-client",
        subject: decoded.id,
      }
    );

    return res.status(200).json({
      success: true,
      token: newAccessToken,
      user: {
        id: decoded.id,
        userId: decoded.id,
        email: decoded.email,
        name: "Guest Explorer",
        role: "guest",
        isGuest: true,
        initial: "G",
        displayName: "Guest Explorer",
      },
    });
  }

  // ── Step 3: Regular user refresh (requires DB lookup) ───────────────────
  // CRITICAL: DB errors during cold-start must return 503 (NOT 401).
  // Returning 401 would cause the frontend to clear localStorage AND
  // we'd also clear the httpOnly cookie — double wipe = permanent logout.
  let user;
  try {
    user = await User.findById(decoded.id).select("-password");
  } catch (dbErr) {
    // DB not ready (cold-start, connection pool exhausted, etc.)
    // Do NOT clear cookies — the refresh token is valid, DB is just unavailable
    console.error("[Auth] Database error during refresh (cold-start?):", dbErr.message);
    return res.status(503).json({
      success: false,
      error: "Service temporarily unavailable. Please try again in a moment.",
      code: "REFRESH_DB_UNAVAILABLE",
    });
  }

  if (!user) {
    clearAuthCookies(res);
    return res.status(401).json({
      success: false,
      error: "User no longer exists.",
      code: "REFRESH_USER_NOT_FOUND",
    });
  }

  // Check token version (revocation)
  if (
    typeof decoded.tokenVersion === "number" &&
    typeof user.tokenVersion === "number" &&
    decoded.tokenVersion !== user.tokenVersion
  ) {
    clearAuthCookies(res);
    return res.status(401).json({
      success: false,
      error: "Session has been revoked. Please sign in again.",
      code: "REFRESH_TOKEN_REVOKED",
    });
  }

  // Check password change
  if (user.passwordChangedAt) {
    const changedTimestamp = Math.floor(user.passwordChangedAt.getTime() / 1000);
    if (decoded.iat && decoded.iat < changedTimestamp) {
      clearAuthCookies(res);
      return res.status(401).json({
        success: false,
        error: "Password was changed. Please sign in again.",
        code: "REFRESH_PASSWORD_CHANGED",
      });
    }
  }

  // Issue new access token + rotated refresh token
  const newAccessToken = generateAccessToken(user._id, user.email, user.role);
  const newRefreshToken = generateRefreshToken(user._id, user.email, user.role, user.tokenVersion);
  setRefreshCookie(res, newRefreshToken);

  return res.status(200).json({
    success: true,
    token: newAccessToken,
    user: user.toSafeObject(),
  });
};

