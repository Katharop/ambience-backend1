// ─────────────────────────────────────────────────────────────────────────────
// controllers/subscriptionController.js
//
// AMBIENCE — Deals Page Subscription Controller (Production-Hardened)
//
// Endpoints:
//   1. createSubscriptionOrder  — Creates Razorpay order for Pro Plan payment
//   2. verifySubscriptionPayment — Server-side HMAC-SHA256 signature verification
//   3. getSubscriptionStatus    — Returns current subscription + history
//   4. cancelSubscription       — Cancels auto-renewal (does not deactivate)
//
// SECURITY PRINCIPLES:
//   • Signature verification is ALWAYS server-side (crypto.createHmac)
//   • Uses crypto.timingSafeEqual to prevent timing attacks
//   • No demo mode — subscription payments must always be real
//   • JWT isProMember claim is advisory only — DB is source of truth
//   • All routes are JWT-protected via the `protect` middleware
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");
const Razorpay = require("razorpay");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const { generateAccessToken } = require("../utils/generateToken");

// ═══════════════════════════════════════════════════════════════════════════════
// Razorpay Instance (shared with paymentController)
// ═══════════════════════════════════════════════════════════════════════════════
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

let razorpayInstance = null;
if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpayInstance = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET,
  });
}

// ── Plan pricing (INR) ──────────────────────────────────────────────────────
const PLAN_PRICES = {
  monthly: 4999,   // ₹4,999/month
  annual: 39999,   // ₹39,999/year (save 33%)
};

const PLAN_DURATIONS_MS = {
  monthly: 30 * 24 * 60 * 60 * 1000,   // 30 days
  annual: 365 * 24 * 60 * 60 * 1000,   // 365 days
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/deals/subscribe
//
// Creates a Razorpay order for Pro Plan subscription payment.
//
// SECURITY:
//   • Razorpay must be configured (no demo/bypass mode)
//   • Prices are server-defined (cannot be set by the client)
//   • Pending Subscription document is created as audit trail
// ═══════════════════════════════════════════════════════════════════════════════
const createSubscriptionOrder = async (req, res) => {
  try {
    // ── Guard: Razorpay must be configured ──────────────────────────────────
    if (!razorpayInstance) {
      console.error("[SUBSCRIPTION] ⛔ Razorpay not configured — subscription blocked");
      return res.status(503).json({
        success: false,
        error: "Payment gateway is not configured. Please contact support.",
        code: "PAYMENT_NOT_CONFIGURED",
      });
    }

    // ── Validate plan ───────────────────────────────────────────────────────
    const { plan } = req.body;
    if (!plan || !PLAN_PRICES[plan]) {
      return res.status(400).json({
        success: false,
        error: "Invalid plan. Choose 'monthly' or 'annual'.",
        code: "INVALID_PLAN",
      });
    }

    // ── Check if user already has an active subscription ────────────────────
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found.",
        code: "USER_NOT_FOUND",
      });
    }

    if (
      user.proSubscription?.isActive &&
      user.proSubscription?.expiresAt &&
      new Date(user.proSubscription.expiresAt) > new Date()
    ) {
      return res.status(400).json({
        success: false,
        error: "You already have an active Pro Plan subscription.",
        code: "ALREADY_SUBSCRIBED",
        expiresAt: user.proSubscription.expiresAt,
      });
    }

    // ── Compute pricing (server-side — never trust client) ──────────────────
    const priceINR = PLAN_PRICES[plan];
    const amountPaise = priceINR * 100;

    // ── Create Razorpay order ───────────────────────────────────────────────
    const razorpayOrder = await razorpayInstance.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `sub_${plan}_${Date.now()}`,
      notes: {
        type: "subscription",
        plan,
        userEmail: req.user.email,
        userId: req.user._id.toString(),
      },
    });

    // ── Save pending Subscription document (audit trail) ────────────────────
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PLAN_DURATIONS_MS[plan]);

    const subscription = new Subscription({
      user: req.user._id,
      plan,
      priceINR,
      status: "pending",
      razorpayOrderId: razorpayOrder.id,
      expiresAt,
    });

    await subscription.save();

    console.log(
      `[SUBSCRIPTION] ✅ Order created | Plan: ${plan} | ` +
      `Amount: ₹${priceINR} | Order: ${razorpayOrder.id} | ` +
      `User: ${req.user.email}`
    );

    return res.status(201).json({
      success: true,
      order_id: razorpayOrder.id,
      amount: amountPaise,
      currency: "INR",
      key_id: RAZORPAY_KEY_ID,
      subscriptionId: subscription._id,
      plan,
      priceINR,
    });
  } catch (error) {
    console.error("[SUBSCRIPTION] ❌ Error creating subscription order:", error.message);

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: "Payment gateway error. Please try again.",
        code: "RAZORPAY_ERROR",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Failed to create subscription order. Please try again.",
      code: "SUBSCRIPTION_ORDER_FAILED",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/deals/verify-subscription
//
// Verifies the Razorpay payment signature using HMAC-SHA256.
// On success, activates the user's Pro Plan subscription.
//
// SECURITY:
//   • Server-side HMAC verification (frontend NEVER computes hashes)
//   • crypto.timingSafeEqual prevents timing attacks
//   • Idempotency guard — duplicate calls return existing result
//   • Fresh JWT issued with isProMember claim
//   • DB is always the source of truth (JWT claim is advisory)
// ═══════════════════════════════════════════════════════════════════════════════
const verifySubscriptionPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      subscriptionId,
    } = req.body;

    // ── Validate required fields ────────────────────────────────────────────
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        error: "Missing payment verification data.",
        code: "MISSING_PAYMENT_DATA",
      });
    }

    // ── Guard: Razorpay must be configured ──────────────────────────────────
    if (!RAZORPAY_KEY_SECRET) {
      return res.status(503).json({
        success: false,
        error: "Payment verification service is not configured.",
        code: "PAYMENT_NOT_CONFIGURED",
      });
    }

    // ── Find the subscription record ────────────────────────────────────────
    let subscription;
    if (subscriptionId) {
      subscription = await Subscription.findOne({
        _id: subscriptionId,
        user: req.user._id,
        razorpayOrderId: razorpay_order_id,
      });
    }

    if (!subscription) {
      subscription = await Subscription.findOne({
        razorpayOrderId: razorpay_order_id,
        user: req.user._id,
      });
    }

    if (!subscription) {
      console.warn(
        `[SUBSCRIPTION] ⚠️ Subscription not found for verification | ` +
        `Order: ${razorpay_order_id} | User: ${req.user.email}`
      );
      return res.status(404).json({
        success: false,
        error: "Subscription order not found.",
        code: "SUBSCRIPTION_NOT_FOUND",
      });
    }

    // ── IDEMPOTENCY GUARD: Already activated? ───────────────────────────────
    if (subscription.status === "active") {
      console.log(
        `[SUBSCRIPTION] ℹ️ Duplicate verification for already-active subscription | ` +
        `User: ${req.user.email}`
      );
      return res.status(200).json({
        success: true,
        message: "Subscription already verified and active.",
        subscription: subscription.toSafeObject(),
      });
    }

    // ── Server-side HMAC-SHA256 signature verification ──────────────────────
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    let isSignatureValid = false;
    try {
      isSignatureValid = crypto.timingSafeEqual(
        Buffer.from(expectedSignature, "hex"),
        Buffer.from(razorpay_signature, "hex")
      );
    } catch (bufferErr) {
      // Buffer length mismatch → invalid signature
      isSignatureValid = false;
    }

    if (!isSignatureValid) {
      // ── FAILED: Signature mismatch ────────────────────────────────────────
      subscription.status = "cancelled";
      subscription.cancelledAt = new Date();
      await subscription.save();

      console.error(
        `[SUBSCRIPTION] ⛔ Signature verification FAILED | ` +
        `Order: ${razorpay_order_id} | IP: ${req.ip} | User: ${req.user.email}`
      );

      return res.status(400).json({
        success: false,
        error: "Payment verification failed. Signature mismatch.",
        code: "SIGNATURE_MISMATCH",
      });
    }

    // ── SUCCESS: Activate subscription ──────────────────────────────────────
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + PLAN_DURATIONS_MS[subscription.plan]
    );

    // Update Subscription document
    subscription.status = "active";
    subscription.razorpayPaymentId = razorpay_payment_id;
    subscription.razorpaySignature = razorpay_signature;
    subscription.subscribedAt = now;
    subscription.expiresAt = expiresAt;
    await subscription.save();

    // Update User's proSubscription snapshot
    const user = await User.findById(req.user._id);
    if (user) {
      user.proSubscription = {
        isActive: true,
        plan: subscription.plan,
        priceINR: subscription.priceINR,
        subscribedAt: now,
        expiresAt,
        razorpaySubId: razorpay_payment_id,
      };
      await user.save({ validateBeforeSave: false });
    }

    // ── Issue fresh JWT with isProMember claim ──────────────────────────────
    // NOTE: The JWT claim is ADVISORY only. The subscriptionGuard middleware
    // ALWAYS verifies against the database. This claim is a convenience for
    // the frontend to show/hide UI elements without an extra API call.
    const freshToken = generateAccessToken(
      user._id,
      user.email,
      user.role,
      user.tokenVersion,
      "15m",
      { isProMember: true }
    );

    console.log(
      `[SUBSCRIPTION] ✅ Pro Plan ACTIVATED | Plan: ${subscription.plan} | ` +
      `Payment: ${razorpay_payment_id} | Expires: ${expiresAt.toISOString()} | ` +
      `User: ${req.user.email}`
    );

    return res.status(200).json({
      success: true,
      message: "Subscription activated successfully! Welcome to the Deals Vault.",
      subscription: subscription.toSafeObject(),
      proSubscription: user.proSubscription,
      isProMember: true,
      token: freshToken,
    });
  } catch (error) {
    console.error("[SUBSCRIPTION] ❌ Error verifying subscription payment:", error.message);

    return res.status(500).json({
      success: false,
      error: "Subscription verification failed. Please contact support.",
      code: "SUBSCRIPTION_VERIFICATION_ERROR",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/deals/verify-subscription
//
// Returns the user's current subscription status and history.
// Used by the frontend to determine whether to show the subscription gate.
// ═══════════════════════════════════════════════════════════════════════════════
const getSubscriptionStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("proSubscription email");
    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found.",
        code: "USER_NOT_FOUND",
      });
    }

    // ── Check if subscription has expired (auto-deactivate) ─────────────────
    const sub = user.proSubscription;
    let isProMember = false;

    if (sub?.isActive && sub?.expiresAt) {
      if (new Date(sub.expiresAt) > new Date()) {
        isProMember = true;
      } else {
        // Auto-deactivate expired subscription
        await User.findByIdAndUpdate(req.user._id, {
          $set: { "proSubscription.isActive": false },
        });
        console.log(
          `[SUBSCRIPTION] ⏰ Auto-deactivated expired subscription | User: ${user.email}`
        );
      }
    }

    // ── Fetch subscription history ──────────────────────────────────────────
    const subscriptionHistory = await Subscription.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const safeHistory = subscriptionHistory.map((s) => ({
      id: s._id,
      plan: s.plan,
      priceINR: s.priceINR,
      status: s.status,
      subscribedAt: s.subscribedAt,
      expiresAt: s.expiresAt,
      autoRenew: s.autoRenew,
      createdAt: s.createdAt,
    }));

    return res.status(200).json({
      success: true,
      isProMember,
      proSubscription: user.proSubscription,
      subscriptionHistory: safeHistory,
    });
  } catch (error) {
    console.error("[SUBSCRIPTION] ❌ Error fetching subscription status:", error.message);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch subscription status.",
      code: "SUBSCRIPTION_STATUS_ERROR",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/deals/cancel-subscription
//
// Cancels auto-renewal on the user's active subscription.
// Does NOT immediately deactivate — lets it expire naturally.
// ═══════════════════════════════════════════════════════════════════════════════
const cancelSubscription = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found.",
        code: "USER_NOT_FOUND",
      });
    }

    if (!user.proSubscription?.isActive) {
      return res.status(400).json({
        success: false,
        error: "No active subscription to cancel.",
        code: "NO_ACTIVE_SUBSCRIPTION",
      });
    }

    // ── Update the latest active Subscription document ──────────────────────
    const activeSubscription = await Subscription.findOne({
      user: req.user._id,
      status: "active",
    }).sort({ createdAt: -1 });

    if (activeSubscription) {
      activeSubscription.autoRenew = false;
      activeSubscription.cancelledAt = new Date();
      await activeSubscription.save();
    }

    console.log(
      `[SUBSCRIPTION] 🚫 Auto-renewal cancelled | ` +
      `Subscription active until: ${user.proSubscription.expiresAt?.toISOString()} | ` +
      `User: ${req.user.email}`
    );

    return res.status(200).json({
      success: true,
      message: "Auto-renewal cancelled. Your subscription remains active until " +
        new Date(user.proSubscription.expiresAt).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "long",
          year: "numeric",
        }) + ".",
      expiresAt: user.proSubscription.expiresAt,
    });
  } catch (error) {
    console.error("[SUBSCRIPTION] ❌ Error cancelling subscription:", error.message);
    return res.status(500).json({
      success: false,
      error: "Failed to cancel subscription.",
      code: "SUBSCRIPTION_CANCEL_ERROR",
    });
  }
};

module.exports = {
  createSubscriptionOrder,
  verifySubscriptionPayment,
  getSubscriptionStatus,
  cancelSubscription,
};
