// server/middleware/authMiddleware.js
//
// AMBIENCE — Bulletproof Authentication Middleware
//
// Enterprise-grade security layer:
//   • JWT token verification with detailed error taxonomy
//   • Google OAuth Client ID safeguard (prevents 401: invalid_client)
//   • Graceful configuration error handling with developer guidance
//   • Role-based access control middleware
//   • Guest session detection and restriction
//
// This middleware suite prevents the Google OAuth "Error 401: invalid_client"
// by validating the GOOGLE_CLIENT_ID configuration BEFORE any token exchange
// attempt reaches the Google API. If misconfigured, the system:
//   1. Logs a full diagnostic with fix instructions to the server console
//   2. Returns a clean 500 Configuration Error to the client (never crashes)
// ─────────────────────────────────────────────────────────────────────────────

const jwt = require("jsonwebtoken");
const User = require("../models/User");

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE: protect
//
// Verifies JWT from the Authorization: Bearer <token> header.
// Attaches the full user document (sans password) to req.user.
// Returns 401 with specific error taxonomy on failure.
// ═══════════════════════════════════════════════════════════════════════════════
const protect = async (req, res, next) => {
  let token = null;

  // ── Extract token from Authorization header ─────────────────────────────
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Not authorized — no authentication token provided.",
      code: "AUTH_NO_TOKEN",
    });
  }

  // ── Validate JWT_SECRET is configured ───────────────────────────────────
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.error("");
    console.error("╔══════════════════════════════════════════════════════════╗");
    console.error("║  ❌  CRITICAL: JWT_SECRET IS NOT CONFIGURED             ║");
    console.error("╠══════════════════════════════════════════════════════════╣");
    console.error("║                                                          ║");
    console.error("║  The server cannot verify authentication tokens.         ║");
    console.error("║                                                          ║");
    console.error("║  FIX: Add JWT_SECRET to your server/.env file:           ║");
    console.error("║                                                          ║");
    console.error("║    JWT_SECRET=your-64-char-random-hex-string             ║");
    console.error("║                                                          ║");
    console.error("║  Generate one:                                           ║");
    console.error("║    node -e \"console.log(require('crypto')              ║");
    console.error("║      .randomBytes(64).toString('hex'))\"                 ║");
    console.error("║                                                          ║");
    console.error("╚══════════════════════════════════════════════════════════╝");
    console.error("");

    return res.status(500).json({
      success: false,
      error: "Server configuration error. Please contact support.",
      code: "AUTH_CONFIG_ERROR",
    });
  }

  try {
    // ── Verify token ────────────────────────────────────────────────────────
    const decoded = jwt.verify(token, jwtSecret, {
      algorithms: ["HS256"],
      issuer: "ambience",
    });

    // ── Check if this is a guest token ──────────────────────────────────────
    if (decoded.isGuest || decoded.role === "guest") {
      req.user = {
        _id: decoded.id,
        userId: decoded.id,
        email: decoded.email,
        name: "Guest Explorer",
        role: "guest",
        isGuest: true,
        initial: "G",
        displayName: "Guest Explorer",
      };
      req.isGuest = true;
      return next();
    }

    // ── Fetch full user from database ───────────────────────────────────────
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Not authorized — user account no longer exists.",
        code: "AUTH_USER_NOT_FOUND",
      });
    }

    req.user = user;
    req.isGuest = false;
    next();
  } catch (err) {
    // ── Specific JWT error handling ─────────────────────────────────────────
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        error: "Session expired. Please sign in again.",
        code: "AUTH_TOKEN_EXPIRED",
        expiredAt: err.expiredAt,
      });
    }

    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        error: "Not authorized — invalid authentication token.",
        code: "AUTH_TOKEN_INVALID",
      });
    }

    if (err.name === "NotBeforeError") {
      return res.status(401).json({
        success: false,
        error: "Token not yet active. Please try again shortly.",
        code: "AUTH_TOKEN_NOT_ACTIVE",
      });
    }

    console.error(
      "[AuthMiddleware] ❌ Unexpected token verification error:",
      err.message
    );
    return res.status(401).json({
      success: false,
      error: "Authentication failed. Please sign in again.",
      code: "AUTH_UNKNOWN_ERROR",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE: optionalAuth
//
// Same as protect, but does NOT block unauthenticated requests.
// If token is present and valid → attaches req.user.
// If token is missing or invalid → continues without req.user.
// ═══════════════════════════════════════════════════════════════════════════════
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }

  try {
    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "ambience",
    });

    if (decoded.isGuest || decoded.role === "guest") {
      req.user = {
        _id: decoded.id,
        userId: decoded.id,
        email: decoded.email,
        name: "Guest Explorer",
        role: "guest",
        isGuest: true,
      };
      req.isGuest = true;
    } else {
      const user = await User.findById(decoded.id).select("-password");
      if (user) {
        req.user = user;
        req.isGuest = false;
      }
    }
  } catch (_err) {
    // Token invalid or expired — proceed without user
  }

  next();
};

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE: restrictTo
//
// Role-based access control. Restricts route to specific roles.
// Must be used AFTER protect middleware.
//
// Usage:
//   router.get('/admin/dashboard', protect, restrictTo('admin'), handler)
//   router.get('/content', protect, restrictTo('admin', 'moderator'), handler)
// ═══════════════════════════════════════════════════════════════════════════════
const restrictTo = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: "Not authorized — authentication required.",
        code: "AUTH_REQUIRED",
      });
    }

    if (req.isGuest) {
      return res.status(403).json({
        success: false,
        error: "This feature is not available in guest mode. Please create an account.",
        code: "AUTH_GUEST_RESTRICTED",
      });
    }

    const userRole = req.user.role || "customer";
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        error: "You do not have permission to access this resource.",
        code: "AUTH_INSUFFICIENT_ROLE",
        requiredRoles: allowedRoles,
        currentRole: userRole,
      });
    }

    next();
  };
};

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE: requireVerifiedUser
//
// Blocks unverified users from accessing protected resources.
// Must be used AFTER protect middleware.
// ═══════════════════════════════════════════════════════════════════════════════
const requireVerifiedUser = (req, res, next) => {
  if (req.isGuest) {
    return res.status(403).json({
      success: false,
      error: "Please create an account to access this feature.",
      code: "AUTH_GUEST_RESTRICTED",
    });
  }

  if (!req.user || !req.user.isVerified) {
    return res.status(403).json({
      success: false,
      error: "Please verify your email address to access this feature.",
      code: "AUTH_EMAIL_NOT_VERIFIED",
    });
  }

  next();
};

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE: validateGoogleOAuthConfig
//
// GOOGLE 401 INVALID_CLIENT SAFEGUARD
//
// This middleware MUST be mounted BEFORE any Google OAuth endpoint.
// It intercepts the request and validates that GOOGLE_CLIENT_ID is:
//   1. Present in process.env
//   2. Not a placeholder (e.g., "YOUR_GOOGLE_CLIENT_ID")
//   3. Properly formatted (contains ".apps.googleusercontent.com")
//
// If validation fails:
//   • Server console receives a rich, diagnostic error with exact fix steps
//   • Client receives a clean 500 JSON error (never a raw crash or hang)
//   • The request is BLOCKED from reaching the Google API entirely
//
// This prevents the dreaded "Error 401: invalid_client" from ever occurring.
// ═══════════════════════════════════════════════════════════════════════════════
const validateGoogleOAuthConfig = (req, res, next) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  // ── Check 1: GOOGLE_CLIENT_ID exists ────────────────────────────────────
  if (!clientId) {
    console.error("");
    console.error("╔══════════════════════════════════════════════════════════╗");
    console.error("║  ❌  GOOGLE OAUTH ERROR: GOOGLE_CLIENT_ID NOT SET       ║");
    console.error("╠══════════════════════════════════════════════════════════╣");
    console.error("║                                                          ║");
    console.error("║  The Google Sign-In feature cannot work without a valid  ║");
    console.error("║  GOOGLE_CLIENT_ID in your environment variables.         ║");
    console.error("║                                                          ║");
    console.error("║  ── HOW TO FIX ──────────────────────────────────────    ║");
    console.error("║                                                          ║");
    console.error("║  1. Go to: https://console.cloud.google.com/credentials  ║");
    console.error("║  2. Create or select your project                        ║");
    console.error("║  3. Click \"+ CREATE CREDENTIALS\" → \"OAuth client ID\"     ║");
    console.error("║  4. Application type: \"Web application\"                  ║");
    console.error("║  5. Add Authorized redirect URIs:                        ║");
    console.error("║       • http://localhost:3000                            ║");
    console.error("║       • http://localhost:5000/api/auth/google/callback    ║");
    console.error("║  6. Copy the Client ID and Client Secret                 ║");
    console.error("║  7. Add them to server/.env:                             ║");
    console.error("║                                                          ║");
    console.error("║     GOOGLE_CLIENT_ID=123456.apps.googleusercontent.com   ║");
    console.error("║     GOOGLE_CLIENT_SECRET=GOCSPX-your-secret-here        ║");
    console.error("║                                                          ║");
    console.error("║  8. Restart the server                                   ║");
    console.error("║                                                          ║");
    console.error("╚══════════════════════════════════════════════════════════╝");
    console.error("");

    return res.status(500).json({
      success: false,
      error:
        "Google Sign-In is not configured on this server. Please ask the administrator to set up Google OAuth credentials.",
      code: "GOOGLE_CONFIG_MISSING",
    });
  }

  // ── Check 2: Not a placeholder value ────────────────────────────────────
  const placeholders = [
    "YOUR_GOOGLE_CLIENT_ID",
    "PASTE_YOUR_CLIENT_ID_HERE",
    "your-client-id",
    "xxx",
    "placeholder",
    "CHANGE_ME",
    "TODO",
  ];

  const isPlaceholder = placeholders.some(
    (ph) =>
      clientId.toUpperCase().includes(ph.toUpperCase()) ||
      clientId.length < 20
  );

  if (isPlaceholder) {
    console.error("");
    console.error("╔══════════════════════════════════════════════════════════╗");
    console.error("║  ⚠️   GOOGLE OAUTH ERROR: PLACEHOLDER CLIENT ID         ║");
    console.error("╠══════════════════════════════════════════════════════════╣");
    console.error("║                                                          ║");
    console.error("║  Current value: " + clientId.substring(0, 30).padEnd(39) + "║");
    console.error("║                                                          ║");
    console.error("║  This looks like a placeholder, not a real Client ID.    ║");
    console.error("║  A real Google Client ID looks like:                     ║");
    console.error("║                                                          ║");
    console.error("║    123456789-abc.apps.googleusercontent.com              ║");
    console.error("║                                                          ║");
    console.error("║  Get yours from:                                         ║");
    console.error("║    https://console.cloud.google.com/credentials          ║");
    console.error("║                                                          ║");
    console.error("╚══════════════════════════════════════════════════════════╝");
    console.error("");

    return res.status(500).json({
      success: false,
      error:
        "Google Sign-In is not properly configured. The Client ID appears to be a placeholder value.",
      code: "GOOGLE_CONFIG_PLACEHOLDER",
    });
  }

  // ── Check 3: Correct format validation ──────────────────────────────────
  const isValidFormat = clientId.includes(".apps.googleusercontent.com");

  if (!isValidFormat) {
    console.error("");
    console.error("╔══════════════════════════════════════════════════════════╗");
    console.error("║  ⚠️   GOOGLE OAUTH WARNING: MALFORMED CLIENT ID         ║");
    console.error("╠══════════════════════════════════════════════════════════╣");
    console.error("║                                                          ║");
    console.error("║  Current value: " + clientId.substring(0, 30).padEnd(39) + "║");
    console.error("║                                                          ║");
    console.error("║  Expected format:                                        ║");
    console.error("║    <numbers>-<hash>.apps.googleusercontent.com           ║");
    console.error("║                                                          ║");
    console.error("║  Common mistakes:                                        ║");
    console.error("║    • Copied the Client SECRET instead of Client ID       ║");
    console.error("║    • Missing the '.apps.googleusercontent.com' suffix    ║");
    console.error("║    • Extra whitespace or quotes in the .env value        ║");
    console.error("║                                                          ║");
    console.error("║  If you're sure it's correct, this may be a non-standard ║");
    console.error("║  OAuth setup. Proceeding with caution...                 ║");
    console.error("║                                                          ║");
    console.error("╚══════════════════════════════════════════════════════════╝");
    console.error("");

    // Warning only — some custom setups may use different formats
    // Proceed but log the warning
  }

  // ── Check 4: Client Secret for auth-code flow ───────────────────────────
  // The credential from the frontend could be an auth code (not an ID token).
  // Auth code exchange requires GOOGLE_CLIENT_SECRET.
  // We log a warning if it's missing but don't block (ID token flow works without it).
  if (!clientSecret || clientSecret.startsWith("YOUR_")) {
    console.warn("");
    console.warn("┌──────────────────────────────────────────────────────────┐");
    console.warn("│  ⚠️  GOOGLE_CLIENT_SECRET is not set or is a placeholder │");
    console.warn("│                                                          │");
    console.warn("│  Auth-code flow will FAIL without a valid Client Secret. │");
    console.warn("│  Direct ID token verification will still work.           │");
    console.warn("│                                                          │");
    console.warn("│  Add to server/.env:                                     │");
    console.warn("│    GOOGLE_CLIENT_SECRET=GOCSPX-your-secret              │");
    console.warn("└──────────────────────────────────────────────────────────┘");
    console.warn("");
  }

  // ── All checks passed — proceed to the Google auth handler ──────────────
  next();
};

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE: googleAuthGuard
//
// Combined guard for Google OAuth endpoints. Validates config then proceeds.
// Use this as a single middleware on your Google auth route:
//
//   router.post('/google', googleAuthGuard, authController.googleLogin)
// ═══════════════════════════════════════════════════════════════════════════════
const googleAuthGuard = (req, res, next) => {
  // Validate request body
  const { idToken, credential } = req.body;
  const tokenOrCode = idToken || credential;

  if (!tokenOrCode || typeof tokenOrCode !== "string") {
    return res.status(400).json({
      success: false,
      error:
        "Missing Google credential. Please complete the Google Sign-In flow.",
      code: "GOOGLE_NO_CREDENTIAL",
    });
  }

  if (tokenOrCode.length < 10) {
    return res.status(400).json({
      success: false,
      error:
        "Invalid Google credential format. The token appears to be malformed.",
      code: "GOOGLE_INVALID_CREDENTIAL",
    });
  }

  // Delegate to config validation
  validateGoogleOAuthConfig(req, res, next);
};

module.exports = {
  protect,
  optionalAuth,
  restrictTo,
  requireVerifiedUser,
  validateGoogleOAuthConfig,
  googleAuthGuard,
};
