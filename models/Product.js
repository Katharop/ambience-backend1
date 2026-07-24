// ─────────────────────────────────────────────────────────────────────────────
// models/Product.js
//
// AMBIENCE — Product Schema (Mongoose)
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    brand: {
      type: String,
      trim: true,
      default: "Ambience",
    },
    category: {
      type: String,
      trim: true,
    },
    subcategory: {
      type: String,
      trim: true,
    },
    retailPrice: {
      type: Number,
      required: [true, "Retail price is required"],
    },
    dealPrice: {
      type: Number,
    },
    description: {
      type: String,
      trim: true,
    },
    highlights: {
      type: [String],
      default: [],
    },
    colorVariants: {
      type: [String],
      default: [],
    },
    sizeVariants: {
      type: [String],
      default: [],
    },
    tags: {
      type: [String],
      default: [],
    },
    tag: {
      type: String,
      trim: true,
    },
    glyph: {
      type: String,
      default: "📦",
    },
    accent: {
      type: String,
      default: "#00f3ff",
    },
    imageUrl: {
      type: String,
    },
    imageUrls: {
      type: [String],
      default: [],
    },
    modelUrl: {
      type: String,
    },
    has3DModel: {
      type: Boolean,
      default: false,
    },
    targetSection: {
      type: String,
      enum: ["shop_general", "deals_luxury", "home_featured", "category_trending"],
    },
    status: {
      type: String,
      enum: ["live", "draft", "archived"],
      default: "live",
    },
    addedBy: {
      type: String,
      default: "admin@ambience.com",
    },
    spec: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

const Product = mongoose.model("Product", productSchema);

module.exports = Product;
