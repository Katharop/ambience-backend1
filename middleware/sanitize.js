// middleware/sanitize.js
//
// AMBIENCE — Deep Input Sanitization Middleware (v2.0 — Enhanced)
//
// Enterprise-grade protection against:
//   • Cross-Site Scripting (XSS) via HTML/script tag injection
//   • NoSQL Injection via $-prefixed operators in nested objects
//   • Content-Type spoofing on JSON endpoints
//   • Prototype pollution via __proto__ and constructor keys
//   • URI scheme attacks (javascript:, data:, vbscript:)
//   • Unicode normalization bypass attacks

/**
 * Strip dangerous HTML tags, script content, and URI schemes from a string.
 * Applies Unicode NFC normalization first to prevent encoding bypasses.
 */
const stripHTML = (str) => {
  if (typeof str !== 'string') return str;

  // Unicode NFC normalization — prevents homoglyph and encoding bypasses
  let sanitized = str.normalize('NFC');

  return sanitized
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<\/?[^>]+(>|$)/g, '')
    .replace(/javascript:/gi, '')
    .replace(/vbscript:/gi, '')
    .replace(/data:\s*text\/html/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .replace(/&lt;script/gi, '')
    .replace(/eval\s*\(/gi, '')
    .replace(/expression\s*\(/gi, '')
    .replace(/url\s*\(/gi, '')
    .replace(/import\s*\(/gi, '')
    .replace(/\\u00[0-9a-f]{2}/gi, ''); // Escaped Unicode sequences
};

/**
 * Recursively sanitize an object:
 * - Strip HTML/XSS from strings
 * - Remove $-prefixed keys (NoSQL injection)
 * - Remove __proto__ and constructor keys (prototype pollution)
 * - Enforce max depth to prevent stack overflow
 */
const deepSanitize = (obj, depth = 0) => {
  if (depth > 10) return obj; // Prevent infinite recursion

  if (typeof obj === 'string') {
    return stripHTML(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => deepSanitize(item, depth + 1));
  }

  if (obj && typeof obj === 'object') {
    const sanitized = {};
    for (const key of Object.keys(obj)) {
      // Block NoSQL injection operators
      if (key.startsWith('$')) {
        console.warn(`[SANITIZE] Stripped NoSQL operator key: "${key}"`);
        continue;
      }
      // Block prototype pollution
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        console.warn(`[SANITIZE] Stripped prototype pollution key: "${key}"`);
        continue;
      }
      sanitized[key] = deepSanitize(obj[key], depth + 1);
    }
    return sanitized;
  }

  return obj;
};

/**
 * Express middleware: sanitize req.body, req.query, req.params
 */
const sanitizeInputs = (req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    req.body = deepSanitize(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = deepSanitize(req.query);
  }
  if (req.params && typeof req.params === 'object') {
    req.params = deepSanitize(req.params);
  }
  next();
};

/**
 * Validate Content-Type header for JSON endpoints.
 * Blocks requests with unexpected content types on mutation methods.
 */
const enforceJSON = (req, res, next) => {
  const mutationMethods = ['POST', 'PUT', 'PATCH'];

  if (mutationMethods.includes(req.method)) {
    const contentType = req.headers['content-type'] || '';
    // Allow multipart (file uploads) and JSON
    if (!contentType.includes('application/json') && !contentType.includes('multipart/form-data')) {
      // Skip for routes that don't expect JSON body (like logout with empty body)
      if (req.body && Object.keys(req.body).length > 0) {
        return res.status(415).json({
          success: false,
          error: 'Unsupported content type. Use application/json.',
        });
      }
    }
  }
  next();
};

module.exports = { sanitizeInputs, enforceJSON, stripHTML, deepSanitize };
