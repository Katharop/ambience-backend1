// ─────────────────────────────────────────────────────────────────────────────
// models/Coupon.js
//
// AMBIENCE — Promotion & Coupon Code Schema (Mongoose)
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, "Coupon code is required"],
      unique: true,
      trim: true,
      uppercase: true,
      minlength: [3, "Code must be at least 3 characters"],
      maxlength: [30, "Code cannot exceed 30 characters"],
      index: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    discountType: {
      type: String,
      enum: {
        values: ["percentage", "fixed"],
        message: "{VALUE} must be either 'percentage' or 'fixed'",
      },
      default: "percentage",
    },
    discountValue: {
      type: Number,
      required: [true, "Discount value is required"],
      min: [1, "Discount value must be greater than 0"],
    },
    minOrderAmount: {
      type: Number,
      default: 0,
      min: [0, "Minimum order amount cannot be negative"],
    },
    maxDiscountAmount: {
      type: Number,
      default: null, // null means no cap for percentage discounts
    },
    expiryDate: {
      type: Date,
      default: null, // null means never expires
    },
    usageLimit: {
      type: Number,
      default: null, // null means unlimited
    },
    timesUsed: {
      type: Number,
      default: 0,
      min: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    applicableCategories: {
      type: [String],
      default: [], // empty means all categories
    },
    createdBy: {
      type: String,
      default: "admin@ambience.com",
    },
  },
  {
    timestamps: true,
  }
);

// Method to validate if coupon is eligible for a given amount
couponSchema.methods.isValidFor = function (orderAmountINR) {
  if (!this.isActive) {
    return { valid: false, reason: "Coupon is currently inactive" };
  }
  if (this.expiryDate && new Date() > new Date(this.expiryDate)) {
    return { valid: false, reason: "Coupon has expired" };
  }
  if (this.usageLimit && this.timesUsed >= this.usageLimit) {
    return { valid: false, reason: "Coupon usage limit reached" };
  }
  if (this.minOrderAmount && orderAmountINR < this.minOrderAmount) {
    return {
      valid: false,
      reason: `Minimum order amount of ₹${this.minOrderAmount.toLocaleString()} required`,
    };
  }
  return { valid: true };
};

// Calculate discount amount for a given order amount
couponSchema.methods.calculateDiscount = function (orderAmountINR) {
  let discount = 0;
  if (this.discountType === "percentage") {
    discount = Math.round((orderAmountINR * this.discountValue) / 100);
    if (this.maxDiscountAmount && discount > this.maxDiscountAmount) {
      discount = this.maxDiscountAmount;
    }
  } else {
    discount = Math.min(orderAmountINR, this.discountValue);
  }
  return Math.max(0, discount);
};

const Coupon = mongoose.model("Coupon", couponSchema);
module.exports = Coupon;
