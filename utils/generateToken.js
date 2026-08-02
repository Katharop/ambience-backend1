// utils/generateToken.js
//
// AMBIENCE — JWT Token Generator (Persistent Login)
//
// Generates long-lived access tokens (365 days) and refresh tokens (365 days).
// Users stay logged in permanently until they manually sign out.
// Security is enforced via password-change invalidation and tokenVersion revocation.
// Includes audience, issuer, subject, and unique JWT ID (jti) claims.

const jwt = require("jsonwebtoken");
const crypto = require("crypto");

/**
 * Generate a long-lived access token (365 days).
 * Persistent login — user stays authenticated until manual logout.
 *
 * @param {string} userId   — User's MongoDB _id
 * @param {string} email    — User's email
 * @param {string} role     — User's role (customer, admin, moderator)
 * @param {string} expiresIn — Override expiry (default: "365d")
 * @returns {string} — Signed JWT access token
 */
const generateAccessToken = (userId, email, role = "customer", expiresIn = "365d") => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not defined in environment variables.");
  }

  return jwt.sign(
    {
      id: userId,
      email,
      role,
      type: "access",
    },
    secret,
    {
      expiresIn,
      algorithm: "HS256",
      issuer: "ambience",
      audience: "ambience-client",
      subject: String(userId),
      jwtid: crypto.randomUUID(),
    }
  );
};

/**
 * Generate a long-lived refresh token (365 days).
 * Used as fallback session renewal via httpOnly cookie.
 *
 * @param {string} userId       — User's MongoDB _id
 * @param {string} email        — User's email
 * @param {string} role         — User's role
 * @param {number} tokenVersion — User's token version (for revocation)
 * @returns {string} — Signed JWT refresh token
 */
const generateRefreshToken = (userId, email, role = "customer", tokenVersion = 0) => {
  const secret = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not defined in environment variables.");
  }

  return jwt.sign(
    {
      id: userId,
      email,
      role,
      type: "refresh",
      tokenVersion,
    },
    secret,
    {
      expiresIn: "365d",
      algorithm: "HS256",
      issuer: "ambience",
      audience: "ambience-client",
      subject: String(userId),
      jwtid: crypto.randomUUID(),
    }
  );
};

// Backward-compatible default export
const generateToken = generateAccessToken;

module.exports = { generateToken, generateAccessToken, generateRefreshToken };
