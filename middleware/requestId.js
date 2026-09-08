// ─────────────────────────────────────────────────────────────────────────────
// middleware/requestId.js
//
// AMBIENCE — Request ID Middleware (Distributed Tracing)
//
// Generates a unique X-Request-ID for every incoming request.
// If a client or proxy already set one, it is preserved.
// The ID is attached to req and the response header for correlation.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

const requestId = (req, res, next) => {
  const id = req.headers["x-request-id"] || crypto.randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-ID", id);
  next();
};

module.exports = { requestId };
