// ─────────────────────────────────────────────────────────────────────────────
// models/FlagshipDeal.js
//
// AMBIENCE — FlagshipDeal Schema (Mongoose)
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

const flagshipDealSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Title is required"],
      trim: true,
    },
    subtitle: {
      type: String,
      trim: true,
    },
    price: {
      type: Number,
      required: [true, "Price is required"],
      min: [1500000, "Price must be at least 1500000"],
    },
    glyph: {
      type: String,
      default: "⌚",
    },
    specs: {
      type: [String],
      default: [],
    },
    imageUrl: {
      type: String,
    },
    modelUrl: {
      type: String,
    },
    isActive: {
      type: Boolean,
      default: false,
    },
    updatedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

const FlagshipDeal = mongoose.model("FlagshipDeal", flagshipDealSchema);

module.exports = FlagshipDeal;
