// ─────────────────────────────────────────────────────────────────────────────
// middleware/subscriptionGuard.js
//
// AMBIENCE — Subscription-Gated Access Middleware
//
// Enforces Pro Plan subscription for Deals Page / Luxury Wallet access.
//
// SECURITY PRINCIPLE:
//   This middleware performs a LIVE DATABASE lookup to verify subscription
//   status. JWT claims (isProMember) are NEVER trusted for authorization.
//   This prevents any client-side manipulation of subscription flags.
//
//   Pattern matches requireAdmin in middleware/auth.js — DB-verified, not
//   JWT-claim-trusted.
//
// Must be used AFTER the `protect` middleware (requires req.user).
// ─────────────────────────────────────────────────────────────────────────────

const User = require("../models/User");

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE: requireActiveSubscription
//
// Checks the user's proSubscription status from the DATABASE.
//   • Active + not expired → next()
//   • Expired → auto-deactivate in DB, return 403
//   • No subscription → return 403
//
// Must be used AFTER protect middleware.
// ═══════════════════════════════════════════════════════════════════════════════
const requireActiveSubscription = async (req, res, next) => {
  // ── Guard: Must have authenticated user ─────────────────────────────────
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: "Not authorized — authentication required.",
      code: "AUTH_REQUIRED",
    });
  }

  // ── Guard: Guests cannot access subscription-gated features ─────────────
  if (req.isGuest) {
    return res.status(403).json({
      success: false,
      error: "Subscription features are not available in guest mode. Please create an account.",
      code: "AUTH_GUEST_RESTRICTED",
    });
  }

  try {
    // ── CRITICAL: Query the database for the CURRENT subscription status ──
    // NEVER trust JWT claims for subscription authorization.
    const dbUser = await User.findById(req.user._id).select("proSubscription email");

    if (!dbUser) {
      return res.status(401).json({
        success: false,
        error: "User account not found.",
        code: "AUTH_USER_NOT_FOUND",
      });
    }

    const sub = dbUser.proSubscription;

    // ── Case 1: No subscription at all ──────────────────────────────────
    if (!sub || !sub.isActive) {
      console.warn(
        `[SUBSCRIPTION] 🚫 Access DENIED — no active subscription | ` +
        `User: ${dbUser.email} | ${req.method} ${req.originalUrl}`
      );
      return res.status(403).json({
        success: false,
        error: "Pro Plan subscription is required to access the Deals Page. Subscribe to unlock premium listing features.",
        code: "SUBSCRIPTION_REQUIRED",
      });
    }

    // ── Case 2: Subscription exists but has expired ─────────────────────
    if (sub.expiresAt && new Date(sub.expiresAt) <= new Date()) {
      // Auto-deactivate expired subscription in the database
      await User.findByIdAndUpdate(req.user._id, {
        $set: { "proSubscription.isActive": false },
      });

      console.warn(
        `[SUBSCRIPTION] ⏰ Subscription EXPIRED — auto-deactivated | ` +
        `User: ${dbUser.email} | Expired: ${sub.expiresAt.toISOString()} | ` +
        `${req.method} ${req.originalUrl}`
      );

      return res.status(403).json({
        success: false,
        error: "Your Pro Plan subscription has expired. Please renew to continue accessing the Deals Page.",
        code: "SUBSCRIPTION_EXPIRED",
        expiredAt: sub.expiresAt,
      });
    }

    // ── Case 3: Active and valid → allow access ─────────────────────────
    // Attach subscription info to request for downstream use
    req.subscription = sub;
    next();
  } catch (err) {
    console.error("[SUBSCRIPTION] ❌ Subscription check failed:", err.message);
    return res.status(500).json({
      success: false,
      error: "Subscription verification failed. Please try again.",
      code: "SUBSCRIPTION_CHECK_ERROR",
    });
  }
};

module.exports = { requireActiveSubscription };
