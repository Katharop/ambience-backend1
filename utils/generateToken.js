// ─────────────────────────────────────────────────────────────────────────────
// utils/generateToken.js
//
// AMBIENCE — JWT Token Generator
//
// Signs a JWT with user identity claims and configurable expiry.
// Uses HS256 algorithm by default.
// ─────────────────────────────────────────────────────────────────────────────

const jwt = require("jsonwebtoken");

/**
 * Generate a signed JWT token.
 *
 * @param {string} userId  — User's MongoDB _id or userId
 * @param {string} email   — User's email
 * @param {string} role    — User's role (customer, admin, moderator)
 * @param {string} expiresIn — Token expiry (default: "7d")
 * @returns {string} — Signed JWT token
 */
const generateToken = (userId, email, role = "customer", expiresIn = "7d") => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error(
      "JWT_SECRET is not defined in environment variables. " +
      "Add JWT_SECRET to your server/.env file."
    );
  }

  return jwt.sign(
    {
      id: userId,
      email,
      role,
    },
    secret,
    {
      expiresIn,
      algorithm: "HS256",
      issuer: "ambience",
      subject: String(userId),
    }
  );
};

module.exports = generateToken;
