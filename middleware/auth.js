// ─────────────────────────────────────────────────────────────────────────────
// middleware/auth.js
//
// AMBIENCE — JWT Authentication Middleware
//
// Extracts and verifies the Bearer token from the Authorization header.
// On success, attaches the user document (sans password) to req.user.
// On failure, returns 401 Unauthorized.
// ─────────────────────────────────────────────────────────────────────────────

const jwt = require("jsonwebtoken");
const User = require("../models/User");

/**
 * Protect routes — require valid JWT.
 *
 * Usage:
 *   router.get("/profile", protect, (req, res) => { ... });
 */
const protect = async (req, res, next) => {
  let token;

  // ── Extract token from Authorization header ─────────────────────────────
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Not authorized — no token provided.",
    });
  }

  try {
    // ── Verify token ────────────────────────────────────────────────────────
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "ambience",
    });

    // ── Fetch user from database (exclude password) ─────────────────────────
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Not authorized — user no longer exists.",
      });
    }

    // ── Attach user to request ──────────────────────────────────────────────
    req.user = user;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        error: "Session expired. Please sign in again.",
      });
    }

    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        error: "Not authorized — invalid token.",
      });
    }

    console.error("[Auth Middleware] ❌ Token verification error:", err.message);
    return res.status(401).json({
      success: false,
      error: "Not authorized — authentication failed.",
    });
  }
};

/**
 * Optional auth — attaches user if token is present, but doesn't block.
 * Useful for routes that work for both guests and authenticated users.
 */
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
    const user = await User.findById(decoded.id).select("-password");
    if (user) req.user = user;
  } catch (_) {
    // Token invalid — proceed without user
  }

  next();
};

module.exports = { protect, optionalAuth };
