// ─────────────────────────────────────────────────────────────────────────────
// models/User.js
//
// AMBIENCE — The Ultimate User Schema (Mongoose)
//
// Features:
//   • Auto-generated professional User ID via crypto.randomUUID()
//   • Full profile: name, email, password, googleId, avatar, dob, phone
//   • Saved addresses array with subdocuments
//   • Role-based access (customer, admin, moderator)
//   • Pre-save bcrypt hashing (12 rounds)
//   • Instance method: matchPassword()
//   • Virtual: initial (first letter of email, uppercase)
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

// ── Address Subdocument Schema ──────────────────────────────────────────────
const addressSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      trim: true,
      default: "Home",
    },
    street: {
      type: String,
      trim: true,
      required: true,
    },
    city: {
      type: String,
      trim: true,
      required: true,
    },
    state: {
      type: String,
      trim: true,
      required: true,
    },
    zip: {
      type: String,
      trim: true,
      required: true,
    },
    country: {
      type: String,
      trim: true,
      default: "India",
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
  },
  { _id: true }
);

// ── User Schema ─────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      default: () => crypto.randomUUID(),
      unique: true,
      index: true,
      immutable: true,
    },

    name: {
      type: String,
      trim: true,
      maxlength: [100, "Name cannot exceed 100 characters"],
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        "Please provide a valid email address",
      ],
      index: true,
    },

    password: {
      type: String,
      minlength: [8, "Password must be at least 8 characters"],
      select: false, // Never return password by default
    },

    googleId: {
      type: String,
      sparse: true,
      index: true,
    },

    avatar: {
      type: String,
      default: null,
    },

    dob: {
      type: Date,
      default: null,
    },

    phone: {
      type: String,
      trim: true,
      default: null,
    },

    savedAddresses: {
      type: [addressSchema],
      default: [],
    },

    role: {
      type: String,
      enum: {
        values: ["customer", "admin", "moderator"],
        message: "{VALUE} is not a valid role",
      },
      default: "customer",
    },

    isVerified: {
      type: Boolean,
      default: false,
    },

    provider: {
      type: String,
      enum: {
        values: ["local", "google", "twitter"],
        message: "{VALUE} is not a valid provider",
      },
      default: "local",
    },

    passwordChangedAt: {
      type: Date,
      default: null,
    },

    tokenVersion: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Virtual: initial ────────────────────────────────────────────────────────
// Returns the first character of the email, uppercased.
// Used for avatar placeholder display.
userSchema.virtual("initial").get(function () {
  return this.email ? this.email.charAt(0).toUpperCase() : "?";
});

// ── Virtual: displayName ────────────────────────────────────────────────────
// Returns name if set, otherwise the email local part.
userSchema.virtual("displayName").get(function () {
  if (this.name) return this.name;
  return this.email ? this.email.split("@")[0] : "User";
});

// ── Pre-save Hook: Hash password ────────────────────────────────────────────
// Only hashes if the password field has been modified (or is new).
// Skips for social auth users who have no password.
userSchema.pre("save", async function () {
  // Skip if password wasn't modified or doesn't exist
  if (!this.isModified("password") || !this.password) {
    return;
  }

  // Password complexity: at least 1 uppercase, 1 lowercase, 1 number
  const complexityRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
  if (!complexityRegex.test(this.password)) {
    const err = new Error(
      "Password must contain at least one uppercase letter, one lowercase letter, and one number."
    );
    err.name = "ValidationError";
    throw err;
  }

  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);

  // Track when password was changed (for token invalidation)
  if (!this.isNew) {
    this.passwordChangedAt = new Date();
  }
});

// ── Method: matchPassword ───────────────────────────────────────────────────
// Compare entered password with the stored bcrypt hash.
userSchema.methods.matchPassword = async function (enteredPassword) {
  if (!this.password) return false;
  return await bcrypt.compare(enteredPassword, this.password);
};

// ── Method: toSafeObject ────────────────────────────────────────────────────
// Returns a sanitized user object without sensitive fields.
userSchema.methods.toSafeObject = function () {
  return {
    id: this._id,
    userId: this.userId,
    name: this.name,
    email: this.email,
    avatar: this.avatar,
    dob: this.dob,
    phone: this.phone,
    savedAddresses: this.savedAddresses,
    role: this.role,
    isVerified: this.isVerified,
    provider: this.provider,
    initial: this.initial,
    displayName: this.displayName,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

const User = mongoose.model("User", userSchema);

module.exports = User;
