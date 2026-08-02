// ─────────────────────────────────────────────────────────────────────────────
// models/Order.js
//
// AMBIENCE — Order Schema (Mongoose)
//
// Stores order data with Razorpay payment references.
// SECURITY: Only Razorpay IDs and payment status are stored.
//           No raw financial data (card numbers, CVVs, etc.) ever touches
//           this model — enforced by paymentGuard middleware.
//
// Fields:
//   • orderId       — Auto-generated "AMB-" prefixed unique order ID
//   • user          — Reference to User model (authenticated via JWT)
//   • items[]       — Snapshot of purchased products at time of order
//   • amount/tax    — Financial summary in paise (INR × 100)
//   • razorpay_*    — Razorpay reference IDs only
//   • paymentStatus — Pending | Success | Failed
//   • orderStatus   — Confirmed → Processing → Shipped → Delivered | Cancelled
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");
const crypto = require("crypto");

// ── Order Item Subdocument ──────────────────────────────────────────────────
const orderItemSchema = new mongoose.Schema(
  {
    productId: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    brand: {
      type: String,
      trim: true,
      default: "",
    },
    category: {
      type: String,
      trim: true,
      default: "",
    },
    priceINR: {
      type: Number,
      required: true,
      min: 0,
    },
    qty: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
  },
  { _id: false }
);

// ── Shipping Address Subdocument ────────────────────────────────────────────
const shippingAddressSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, default: "Home" },
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    zip: { type: String, trim: true },
    country: { type: String, trim: true, default: "India" },
  },
  { _id: false }
);

// ── Order Schema ────────────────────────────────────────────────────────────
const orderSchema = new mongoose.Schema(
  {
    orderId: {
      type: String,
      unique: true,
      index: true,
      default: () => {
        const timestamp = Date.now().toString(36).toUpperCase();
        const random = crypto.randomBytes(3).toString("hex").toUpperCase();
        return `AMB-${timestamp}-${random}`;
      },
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    userEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },

    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (arr) => arr.length > 0,
        message: "Order must contain at least one item.",
      },
    },

    // ── Financial Summary (amounts in paise = INR × 100) ──────────────────
    amount: {
      type: Number,
      required: true,
      min: 100, // Minimum ₹1
    },

    taxAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalAmount: {
      type: Number,
      required: true,
      min: 100,
    },

    currency: {
      type: String,
      default: "INR",
      enum: ["INR"],
    },

    // ── Razorpay References (IDs only — NEVER raw payment data) ───────────
    razorpay_order_id: {
      type: String,
      required: true,
      index: true,
    },

    razorpay_payment_id: {
      type: String,
      default: null,
    },

    razorpay_signature: {
      type: String,
      default: null,
    },

    // ── Status Tracking ───────────────────────────────────────────────────
    paymentStatus: {
      type: String,
      enum: {
        values: ["Pending", "Success", "Failed"],
        message: "{VALUE} is not a valid payment status",
      },
      default: "Pending",
      index: true,
    },

    orderStatus: {
      type: String,
      enum: {
        values: ["Confirmed", "Processing", "Shipped", "Delivered", "Cancelled"],
        message: "{VALUE} is not a valid order status",
      },
      default: "Confirmed",
    },

    // ── Shipping ──────────────────────────────────────────────────────────
    shippingAddress: {
      type: shippingAddressSchema,
      default: null,
    },

    // ── Metadata ──────────────────────────────────────────────────────────
    paidAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Virtual: itemCount ──────────────────────────────────────────────────────
orderSchema.virtual("itemCount").get(function () {
  return this.items.reduce((sum, item) => sum + item.qty, 0);
});

// ── Virtual: displayAmount (INR formatted) ──────────────────────────────────
orderSchema.virtual("displayAmount").get(function () {
  return "₹" + (this.totalAmount / 100).toLocaleString("en-IN");
});

// ── Method: toSafeObject ────────────────────────────────────────────────────
// Returns order data safe for frontend consumption.
orderSchema.methods.toSafeObject = function () {
  return {
    orderId: this.orderId,
    items: this.items,
    amount: this.amount,
    taxAmount: this.taxAmount,
    totalAmount: this.totalAmount,
    currency: this.currency,
    paymentStatus: this.paymentStatus,
    orderStatus: this.orderStatus,
    shippingAddress: this.shippingAddress,
    razorpay_order_id: this.razorpay_order_id,
    razorpay_payment_id: this.razorpay_payment_id,
    itemCount: this.itemCount,
    displayAmount: this.displayAmount,
    paidAt: this.paidAt,
    createdAt: this.createdAt,
  };
};

const Order = mongoose.model("Order", orderSchema);

module.exports = Order;
