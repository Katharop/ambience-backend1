// ─────────────────────────────────────────────────────────────────────────────
// middleware/auth.js
//
// AMBIENCE — Enterprise Authentication Middleware (v4.0 — Fort Knox Edition)
//
// Security layers:
//   • JWT verification with algorithm pinning (HS256 only)
//   • Token version check (emergency mass-revocation support)
//   • Password change detection (tokens issued before password change = invalid)
//   • requireAdmin — verifies role in the DATABASE, not just the JWT claim
//   • httpOnly cookie management for refresh tokens
//   • Guest session detection and restriction
//
// Access Token: Read from Authorization: Bearer header (stored in JS memory)
// Refresh Token: Read from httpOnly cookie (set by login/register endpoints)
// ─────────────────────────────────────────────────────────────────────────────

const jwt = require("jsonwebtoken");
const User = require("../models/User");

// ═══════════════════════════════════════════════════════════════════════════════
// COOKIE CONFIGURATION
//
// Access token:  Sent via Authorization header (in-memory on frontend)
// Refresh token: httpOnly cookie — inaccessible to JavaScript
//
// SameSite=None + Secure=true required for cross-origin cookies
// (frontend on Netlify/Vercel, backend on Render = different domains)
// ═══════════════════════════════════════════════════════════════════════════════

const getCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
});

const REFRESH_COOKIE_NAME = "ambience_refresh";

/**
 * Set the refresh token as an httpOnly cookie.
 */
const setRefreshCookie = (res, token) => {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...getCookieOptions(),
    maxAge: 365 * 24 * 60 * 60 * 1000, // 365 days — persistent login
    path: "/api/auth",                  // Only sent to auth endpoints
  });
};

/**
 * Clear authentication cookies.
 */
const clearAuthCookies = (res) => {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    ...getCookieOptions(),
    path: "/api/auth",
  });
};

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE: protect
//
// Verifies JWT from the Authorization: Bearer <token> header.
// Attaches the full user document (sans password) to req.user.
// Checks token version and password change timestamp.
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

  // ── Validate JWT_SECRET ─────────────────────────────────────────────────
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.error("[Auth] CRITICAL: JWT_SECRET is not configured");
    return res.status(500).json({
      success: false,
      error: "Server configuration error.",
      code: "AUTH_CONFIG_ERROR",
    });
  }

  // ── Verify token (algorithm-pinned, issuer-verified) ────────────────────
  let decoded;
  try {
    decoded = jwt.verify(token, jwtSecret, {
      algorithms: ["HS256"],
      issuer: "ambience",
      audience: "ambience-client",
    });
  } catch (err) {
    // JWT verification errors → 401 (token is genuinely invalid/expired)
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

    console.error("[Auth] Unexpected JWT verification error:", err.message);
    return res.status(401).json({
      success: false,
      error: "Authentication failed. Please sign in again.",
      code: "AUTH_UNKNOWN_ERROR",
    });
  }

  // ── Guest token handling ──────────────────────────────────────────────
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

  // ── Fetch full user from database (exclude password) ──────────────────
  // CRITICAL: DB errors during cold-start must return 503 (NOT 401).
  // Returning 401 here would cause the frontend to clear localStorage
  // and log the user out, even though their token is perfectly valid.
  let user;
  try {
    user = await User.findById(decoded.id).select("-password");
  } catch (dbErr) {
    console.error("[Auth] Database error during user lookup (cold-start?):", dbErr.message);
    return res.status(503).json({
      success: false,
      error: "Service temporarily unavailable. Please try again in a moment.",
      code: "AUTH_DB_UNAVAILABLE",
    });
  }

  if (!user) {
    return res.status(401).json({
      success: false,
      error: "Not authorized — user account no longer exists.",
      code: "AUTH_USER_NOT_FOUND",
    });
  }

  // ── Security Check: Password change invalidation ──────────────────────
  // If the user changed their password AFTER this token was issued,
  // the token is invalid (prevents use of stolen tokens after password reset)
  if (user.passwordChangedAt) {
    const changedTimestamp = Math.floor(user.passwordChangedAt.getTime() / 1000);
    if (decoded.iat && decoded.iat < changedTimestamp) {
      return res.status(401).json({
        success: false,
        error: "Password was recently changed. Please sign in again.",
        code: "AUTH_PASSWORD_CHANGED",
      });
    }
  }

  // ── Security Check: Token version (emergency revocation) ──────────────
  // If the user's tokenVersion was incremented (e.g., "sign out everywhere"),
  // all previously issued refresh tokens become invalid
  if (
    typeof decoded.tokenVersion === "number" &&
    typeof user.tokenVersion === "number" &&
    decoded.tokenVersion !== user.tokenVersion
  ) {
    return res.status(401).json({
      success: false,
      error: "Session has been invalidated. Please sign in again.",
      code: "AUTH_TOKEN_REVOKED",
    });
  }

  // ── Attach user to request ────────────────────────────────────────────
  req.user = user;
  req.isGuest = false;
  next();
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
// MIDDLEWARE: requireAdmin
//
// ENTERPRISE ADMIN GUARD — Checks the user's role in the DATABASE.
//
// Unlike restrictTo("admin") which only checks the JWT claim, this middleware
// performs a LIVE database lookup to verify the user still has admin privileges.
// This prevents privilege escalation if an admin's role is revoked after
// their JWT was issued.
//
// Must be used AFTER protect middleware.
// ═══════════════════════════════════════════════════════════════════════════════
const requireAdmin = async (req, res, next) => {
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
      error: "This feature is not available in guest mode.",
      code: "AUTH_GUEST_RESTRICTED",
    });
  }

  try {
    // CRITICAL: Query the database for the CURRENT role, not the JWT claim
    const dbUser = await User.findById(req.user._id).select("role");

    if (!dbUser || dbUser.role !== "admin") {
      console.warn(
        `[SECURITY] ⚠️  Admin access DENIED for ${req.user.email} ` +
        `(DB role: ${dbUser?.role || "unknown"}) — ${req.method} ${req.originalUrl}`
      );
      return res.status(403).json({
        success: false,
        error: "You do not have admin permissions.",
        code: "AUTH_INSUFFICIENT_ROLE",
      });
    }

    next();
  } catch (err) {
    console.error("[Auth] requireAdmin DB check failed:", err.message);
    return res.status(500).json({
      success: false,
      error: "Authorization check failed. Please try again.",
      code: "AUTH_CHECK_ERROR",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE: restrictTo
//
// Role-based access control — checks the JWT claim (faster, less secure).
// For admin routes, prefer requireAdmin (DB-verified) instead.
// Must be used AFTER protect middleware.
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
      });
    }

    next();
  };
};

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE: requireVerifiedUser
//
// Blocks unverified users and guests from accessing protected resources.
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

module.exports = {
  protect,
  optionalAuth,
  restrictTo,
  requireAdmin,
  requireVerifiedUser,
  setRefreshCookie,
  clearAuthCookies,
  getCookieOptions,
  REFRESH_COOKIE_NAME,
};
