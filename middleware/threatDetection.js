// middleware/threatDetection.js
//
// AMBIENCE — AI/Automated Threat Detection Middleware
//
// Detects anomalous behavior patterns and auto-blocks malicious IPs:
//   • Tracks unique endpoints hit per IP per minute
//   • Auto-blocks IPs exceeding 100 unique endpoints in 60 seconds
//   • Tracks auth failure bursts per IP
//   • In-memory blocklist with 30-minute TTL auto-unblock
//   • Logs suspicious activity with full request details

const WINDOW_MS = 60 * 1000;           // 1-minute sliding window
const MAX_UNIQUE_ENDPOINTS = 100;      // Max unique endpoints per window
const BLOCK_DURATION_MS = 30 * 60 * 1000; // 30-minute block
const AUTH_FAIL_WINDOW_MS = 5 * 60 * 1000; // 5-minute window for auth failures
const MAX_AUTH_FAILURES = 10;          // Max auth failures before block

// In-memory stores
const ipActivity = new Map();    // IP -> { endpoints: Set, windowStart: number }
const ipBlocklist = new Map();   // IP -> { blockedAt: number, reason: string }
const authFailures = new Map();  // IP -> { count: number, windowStart: number }

/**
 * Get the real client IP (supports proxies)
 */
const getClientIP = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || 'unknown';
};

/**
 * Record an authentication failure for an IP
 */
const recordAuthFailure = (req) => {
  const ip = getClientIP(req);
  const now = Date.now();
  let entry = authFailures.get(ip);

  if (!entry || now - entry.windowStart > AUTH_FAIL_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    authFailures.set(ip, entry);
  }

  entry.count++;

  if (entry.count >= MAX_AUTH_FAILURES) {
    ipBlocklist.set(ip, {
      blockedAt: now,
      reason: `Excessive auth failures: ${entry.count} in ${Math.round(AUTH_FAIL_WINDOW_MS / 60000)}min`,
    });
    authFailures.delete(ip);
    console.warn(`[THREAT] ⛔ IP BLOCKED (auth abuse): ${ip} — ${entry.count} auth failures`);
  }
};

/**
 * Main threat detection middleware
 */
const threatDetection = (req, res, next) => {
  const ip = getClientIP(req);
  const now = Date.now();

  // ── Check blocklist ──
  const blockEntry = ipBlocklist.get(ip);
  if (blockEntry) {
    if (now - blockEntry.blockedAt < BLOCK_DURATION_MS) {
      const remaining = Math.ceil((BLOCK_DURATION_MS - (now - blockEntry.blockedAt)) / 60000);
      return res.status(403).json({
        success: false,
        error: 'Access temporarily restricted due to suspicious activity.',
        retryAfterMinutes: remaining,
      });
    }
    // Block expired — remove
    ipBlocklist.delete(ip);
  }

  // ── Track unique endpoints ──
  const endpoint = `${req.method}:${req.path}`;
  let activity = ipActivity.get(ip);

  if (!activity || now - activity.windowStart > WINDOW_MS) {
    activity = { endpoints: new Set(), windowStart: now };
    ipActivity.set(ip, activity);
  }

  activity.endpoints.add(endpoint);

  // ── Check threshold ──
  if (activity.endpoints.size > MAX_UNIQUE_ENDPOINTS) {
    ipBlocklist.set(ip, {
      blockedAt: now,
      reason: `Endpoint scanning: ${activity.endpoints.size} unique endpoints in ${WINDOW_MS / 1000}s`,
    });
    ipActivity.delete(ip);

    console.warn(
      `[THREAT] ⛔ IP BLOCKED (scanning): ${ip} — ` +
      `${activity.endpoints.size} unique endpoints in ${WINDOW_MS / 1000}s`
    );

    return res.status(403).json({
      success: false,
      error: 'Access temporarily restricted due to suspicious activity.',
    });
  }

  next();
};

// ── Periodic cleanup (every 5 minutes) ──
setInterval(() => {
  const now = Date.now();

  for (const [ip, entry] of ipBlocklist) {
    if (now - entry.blockedAt >= BLOCK_DURATION_MS) {
      ipBlocklist.delete(ip);
    }
  }

  for (const [ip, entry] of ipActivity) {
    if (now - entry.windowStart > WINDOW_MS * 2) {
      ipActivity.delete(ip);
    }
  }

  for (const [ip, entry] of authFailures) {
    if (now - entry.windowStart > AUTH_FAIL_WINDOW_MS * 2) {
      authFailures.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

module.exports = { threatDetection, recordAuthFailure, getClientIP };
