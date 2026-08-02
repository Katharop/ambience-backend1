// ─────────────────────────────────────────────────────────────────────────────
// middleware/authMiddleware.js
//
// AMBIENCE — Backward-Compatible Auth Middleware Re-exports
//
// All auth middleware is now consolidated in middleware/auth.js.
// This file re-exports everything for backward compatibility with
// any existing imports that reference "./middleware/authMiddleware".
// ─────────────────────────────────────────────────────────────────────────────

const {
  protect,
  optionalAuth,
  restrictTo,
  requireAdmin,
  requireVerifiedUser,
  setRefreshCookie,
  clearAuthCookies,
  getCookieOptions,
  REFRESH_COOKIE_NAME,
} = require("./auth");

// ═══════════════════════════════════════════════════════════════════════════════
// Google OAuth Config Validation (kept here for separation of concerns)
// ═══════════════════════════════════════════════════════════════════════════════
const validateGoogleOAuthConfig = (req, res, next) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;

  if (!clientId || clientId.length < 20 || clientId.toUpperCase().includes("YOUR_")) {
    return res.status(500).json({
      success: false,
      error: "Google Sign-In is not configured. Please contact the administrator.",
      code: "GOOGLE_CONFIG_MISSING",
    });
  }

  next();
};

const googleAuthGuard = (req, res, next) => {
  const { idToken, credential } = req.body;
  const tokenOrCode = idToken || credential;

  if (!tokenOrCode || typeof tokenOrCode !== "string" || tokenOrCode.length < 10) {
    return res.status(400).json({
      success: false,
      error: "Missing or invalid Google credential.",
      code: "GOOGLE_NO_CREDENTIAL",
    });
  }

  validateGoogleOAuthConfig(req, res, next);
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
  validateGoogleOAuthConfig,
  googleAuthGuard,
};
