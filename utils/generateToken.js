// utils/generateToken.js
//
// AMBIENCE — JWT Token Generator (Short-Lived Access + Long-Lived Refresh)
//
// Access tokens:  15 minutes — stored in-memory on frontend (NOT localStorage)
// Refresh tokens: 30 days — stored in httpOnly cookie
//
// Security enforced via:
//   • tokenVersion claim (emergency mass-revocation)
//   • Password-change invalidation (tokens issued before change = invalid)
//   • Algorithm pinning (HS256 only)
//   • Audience, issuer, subject, and unique JWT ID (jti) claims

const jwt = require("jsonwebtoken");
const crypto = require("crypto");

/**
 * Generate a short-lived access token (15 minutes).
 * Stored in-memory only — never in localStorage.
 *
 * @param {string} userId       — User's MongoDB _id
 * @param {string} email        — User's email
 * @param {string} role         — User's role (customer, admin, moderator)
 * @param {number} tokenVersion — User's token version (for revocation)
 * @param {string} expiresIn    — Override expiry (default: "15m")
 * @returns {string} — Signed JWT access token
 */
const generateAccessToken = (userId, email, role = "customer", tokenVersion = 0, expiresIn = "15m") => {
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
      tokenVersion,
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
 * Generate a long-lived refresh token (30 days).
 * Stored as httpOnly cookie — inaccessible to JavaScript.
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
      expiresIn: "30d",
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
