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
      enum: ["men", "women", "electronics", "footwear", "accessories", "fragrances", "cosmetics", "timepieces", "home", "sports", "other", "Men's Fashion", "Women's Fashion", "Electronics", "Footwear", "Fragrances", "Cosmetics", "Accessories", "Timepieces", "Home & Living", "Luxury Automotive", "Art & Collectibles"],
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
    colorVariants: [{
      name: { type: String, required: true },
      hex: { type: String, required: true },
      imageUrl: { type: String, default: '' },
      modelUrl: { type: String, default: '' },
    }],
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
    subImages: {
      type: [String],
      default: [],
      validate: [arr => arr.length <= 8, 'Maximum 8 sub-images allowed'],
    },
    specifications: {
      type: Map,
      of: String,
      default: () => new Map(),
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
      enum: ["shop_general", "deals_luxury", "home_featured", "category_trending", "category_only"],
    },
    status: {
      type: String,
      enum: ["live", "draft", "archived", "pending"],
      default: "live",
    },
    addedBy: {
      type: String,
      default: "admin@ambience.com",
    },
    submittedBy: {
      type: String,
      default: null,
    },
    source: {
      type: String,
      enum: ["admin", "creator_hub", null],
      default: null,
    },
    isOfficial: {
      type: Boolean,
      default: true,
    },
    isApproved: {
      type: Boolean,
      default: true, // Default true for official/admin created, but submissions will explicitly override this to false
    },
    spec: {
      type: String,
      trim: true,
    },
    dynamicSpecs: [{
      label: { type: String, trim: true },
      value: { type: String, trim: true },
    }],
    soldCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

const Product = mongoose.model("Product", productSchema);

module.exports = Product;
