// ─────────────────────────────────────────────────────────────────────────────
// models/Subscription.js
//
// AMBIENCE — Subscription Audit Trail Schema (Mongoose)
//
// Tracks the full lifecycle of Pro Plan subscriptions for the Deals Page /
// Luxury Wallet. The User model's `proSubscription` embedded document holds
// the ACTIVE snapshot; this collection is the immutable audit trail.
//
// Security:
//   • Only Razorpay reference IDs are stored — never raw payment data
//   • Signature verification happens server-side before any record update
//   • Status transitions are strictly controlled (no client-side mutation)
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

const subscriptionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    plan: {
      type: String,
      enum: {
        values: ["monthly", "annual"],
        message: "{VALUE} is not a valid subscription plan",
      },
      required: [true, "Subscription plan is required"],
    },

    priceINR: {
      type: Number,
      required: [true, "Subscription price is required"],
      min: [0, "Price cannot be negative"],
    },

    status: {
      type: String,
      enum: {
        values: ["active", "expired", "cancelled", "pending"],
        message: "{VALUE} is not a valid subscription status",
      },
      default: "pending",
      index: true,
    },

    // ── Razorpay References (IDs only — NEVER raw payment data) ─────────────
    razorpayOrderId: {
      type: String,
      index: true,
    },

    razorpayPaymentId: {
      type: String,
      default: null,
    },

    razorpaySignature: {
      type: String,
      default: null,
    },

    // ── Lifecycle Timestamps ────────────────────────────────────────────────
    subscribedAt: {
      type: Date,
      default: null,
    },

    expiresAt: {
      type: Date,
      required: [true, "Subscription expiry date is required"],
      index: true,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    autoRenew: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Compound Indexes ────────────────────────────────────────────────────────
subscriptionSchema.index({ user: 1, status: 1 });
subscriptionSchema.index({ user: 1, expiresAt: -1 });

// ── Virtual: isActive ───────────────────────────────────────────────────────
subscriptionSchema.virtual("isCurrentlyActive").get(function () {
  return (
    this.status === "active" &&
    this.expiresAt &&
    new Date(this.expiresAt) > new Date()
  );
});

// ── Method: toSafeObject ────────────────────────────────────────────────────
subscriptionSchema.methods.toSafeObject = function () {
  return {
    id: this._id,
    plan: this.plan,
    priceINR: this.priceINR,
    status: this.status,
    subscribedAt: this.subscribedAt,
    expiresAt: this.expiresAt,
    autoRenew: this.autoRenew,
    isCurrentlyActive: this.isCurrentlyActive,
    createdAt: this.createdAt,
  };
};

const Subscription = mongoose.model("Subscription", subscriptionSchema);

module.exports = Subscription;
