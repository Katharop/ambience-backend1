// ─────────────────────────────────────────────────────────────────────────────
// sessionStore.js
//
// AMBIENCE — In-Memory Session Store (OTP + Login Lockout)
//
// Lightweight in-memory store for ephemeral auth data:
//   • OTP codes (20-minute TTL, auto-cleanup)
//   • Login attempt tracking (15-minute lockout window)
//
// This replaces the old flat-file JSON store. All data is ephemeral and
// lives only in server memory. A server restart clears all OTPs and
// lockouts (which is acceptable for these short-lived items).
//
// For production at scale, replace with Redis.
// ─────────────────────────────────────────────────────────────────────────────

// ── OTP Store ───────────────────────────────────────────────────────────────
// Key: "email:type" → { otp, expiresAt, attempts }
const otpStore = new Map();

const OTP_TTL_MS = 20 * 60 * 1000;      // 20 minutes
const OTP_MAX_ATTEMPTS = 5;

/**
 * Store an OTP for a given email and type.
 * Overwrites any existing OTP for the same email+type.
 */
const storeOTP = (identifier, otp, type = "register") => {
  const key = `${identifier.toLowerCase()}:${type}`;
  otpStore.set(key, {
    otp,
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
  });
};

/**
 * Verify an OTP. Returns { valid: true } or { valid: false, error: string }.
 * Automatically clears the OTP on success or max attempts.
 */
const verifyOTP = (identifier, otp, type = "register") => {
  const key = `${identifier.toLowerCase()}:${type}`;
  const entry = otpStore.get(key);

  if (!entry) {
    return {
      valid: false,
      error: "No verification code found. Please request a new one.",
    };
  }

  if (Date.now() > entry.expiresAt) {
    otpStore.delete(key);
    return {
      valid: false,
      error: "Verification code expired. Please request a new one.",
    };
  }

  entry.attempts += 1;

  if (entry.attempts > OTP_MAX_ATTEMPTS) {
    otpStore.delete(key);
    return {
      valid: false,
      error: "Too many incorrect attempts. Please request a new code.",
    };
  }

  if (entry.otp !== otp) {
    return {
      valid: false,
      error: `Incorrect code. ${OTP_MAX_ATTEMPTS - entry.attempts} attempt${OTP_MAX_ATTEMPTS - entry.attempts !== 1 ? "s" : ""} remaining.`,
    };
  }

  // Success — clear the OTP
  otpStore.delete(key);
  return { valid: true };
};

/**
 * Clear any stored OTP for the given email (all types).
 */
const clearOTP = (identifier) => {
  const prefix = identifier.toLowerCase();
  for (const key of otpStore.keys()) {
    if (key.startsWith(prefix)) {
      otpStore.delete(key);
    }
  }
};

// ── Login Attempt Tracking ──────────────────────────────────────────────────
// Key: email → { attempts, firstAttemptAt, lockedUntil }
const loginAttempts = new Map();

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Check if an account is currently locked.
 * Returns { locked: boolean, remainingSeconds?: number }
 */
const isAccountLocked = (identifier) => {
  const key = identifier.toLowerCase();
  const entry = loginAttempts.get(key);

  if (!entry || !entry.lockedUntil) {
    return { locked: false };
  }

  if (Date.now() < entry.lockedUntil) {
    return {
      locked: true,
      remainingSeconds: Math.ceil((entry.lockedUntil - Date.now()) / 1000),
    };
  }

  // Lock expired — clear it
  loginAttempts.delete(key);
  return { locked: false };
};

/**
 * Record a failed login attempt.
 * Returns { locked: boolean, remainingAttempts: number }
 */
const recordFailedLogin = (identifier) => {
  const key = identifier.toLowerCase();
  let entry = loginAttempts.get(key);

  if (!entry) {
    entry = { attempts: 0, firstAttemptAt: Date.now(), lockedUntil: null };
    loginAttempts.set(key, entry);
  }

  entry.attempts += 1;

  if (entry.attempts >= MAX_LOGIN_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    return { locked: true, remainingAttempts: 0 };
  }

  return {
    locked: false,
    remainingAttempts: MAX_LOGIN_ATTEMPTS - entry.attempts,
  };
};

/**
 * Clear login attempt tracking after a successful login.
 */
const clearLoginAttempts = (identifier) => {
  loginAttempts.delete(identifier.toLowerCase());
};

// ── Periodic Cleanup (every 5 minutes) ──────────────────────────────────────
setInterval(() => {
  const now = Date.now();

  // Clean expired OTPs
  for (const [key, entry] of otpStore) {
    if (now > entry.expiresAt) {
      otpStore.delete(key);
    }
  }

  // Clean expired lockouts
  for (const [key, entry] of loginAttempts) {
    if (entry.lockedUntil && now > entry.lockedUntil) {
      loginAttempts.delete(key);
    }
  }
}, 5 * 60 * 1000).unref(); // .unref() prevents this timer from keeping the process alive

module.exports = {
  storeOTP,
  verifyOTP,
  clearOTP,
  recordFailedLogin,
  isAccountLocked,
  clearLoginAttempts,
};
