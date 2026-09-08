// ─────────────────────────────────────────────────────────────────────────────
// middleware/validators.js
//
// AMBIENCE — Express-Validator Chains (Strict Input Validation)
//
// Schema-level request validation for all critical endpoints.
// These validation chains reject malformed requests BEFORE they reach
// the controller, providing a defense-in-depth layer beyond sanitization.
//
// Usage:
//   app.post("/api/payment/create-order", validateCreateOrder, protect, controller);
// ─────────────────────────────────────────────────────────────────────────────

const { body, validationResult } = require("express-validator");

// ── Shared: Validation error handler ────────────────────────────────────────
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const messages = errors.array().map((e) => e.msg);
    console.warn(
      `[VALIDATOR] ⛔ Validation failed: ${req.method} ${req.path} | ` +
      `IP: ${req.ip} | Errors: ${messages.join("; ")}`
    );
    return res.status(400).json({
      success: false,
      error: messages[0], // Return first error for clean UX
      errors: messages,
      code: "VALIDATION_ERROR",
    });
  }
  next();
};

// ═══════════════════════════════════════════════════════════════════════════════
// Payment Validators
// ═══════════════════════════════════════════════════════════════════════════════

const validateCreateOrder = [
  body("items")
    .isArray({ min: 1 })
    .withMessage("Cart must contain at least one item."),
  body("items.*.name")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Each item must have a name.")
    .isLength({ max: 200 })
    .withMessage("Item name must be under 200 characters."),
  body("items.*.priceINR")
    .isFloat({ min: 0.01, max: 10000000 })
    .withMessage("Item price must be between ₹0.01 and ₹1,00,00,000."),
  body("items.*.qty")
    .isInt({ min: 1, max: 100 })
    .withMessage("Item quantity must be between 1 and 100."),
  body("items.*.productId")
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 }),
  body("items.*.brand")
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 }),
  body("items.*.category")
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 }),
  body("shippingAddress")
    .optional({ nullable: true })
    .isObject()
    .withMessage("Shipping address must be an object."),
  body("shippingAddress.street")
    .optional()
    .isString()
    .trim()
    .isLength({ max: 500 }),
  body("shippingAddress.city")
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 }),
  body("shippingAddress.state")
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 }),
  body("shippingAddress.zip")
    .optional()
    .isString()
    .trim()
    .matches(/^[0-9A-Za-z\s-]{3,10}$/)
    .withMessage("Invalid postal/zip code format."),
  handleValidationErrors,
];

const validateVerifyPayment = [
  body("razorpay_order_id")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Razorpay order ID is required.")
    .matches(/^(order_[A-Za-z0-9]{14,}|demo_order_.+)$/)
    .withMessage("Invalid Razorpay order ID format."),
  body("razorpay_payment_id")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Razorpay payment ID is required.")
    .matches(/^(pay_[A-Za-z0-9]{14,}|demo_payment_.+)$/)
    .withMessage("Invalid Razorpay payment ID format."),
  body("razorpay_signature")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Razorpay signature is required.")
    .isLength({ min: 10, max: 128 })
    .withMessage("Invalid signature length."),
  handleValidationErrors,
];

// ═══════════════════════════════════════════════════════════════════════════════
// Auth Validators
// ═══════════════════════════════════════════════════════════════════════════════

const validateRegister = [
  body("email")
    .isEmail()
    .normalizeEmail()
    .withMessage("Please provide a valid email address."),
  body("password")
    .isString()
    .isLength({ min: 8, max: 128 })
    .withMessage("Password must be between 8 and 128 characters.")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage("Password must contain at least one uppercase letter, one lowercase letter, and one number."),
  body("confirmPassword")
    .isString()
    .notEmpty()
    .withMessage("Please confirm your password."),
  body("name")
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 })
    .withMessage("Name must be under 100 characters."),
  body("phone")
    .optional()
    .isString()
    .trim()
    .matches(/^[+]?[0-9\s-]{7,15}$/)
    .withMessage("Invalid phone number format."),
  handleValidationErrors,
];

const validateLogin = [
  body("identifier")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Email or phone number is required.")
    .isLength({ max: 320 }),
  body("password")
    .isString()
    .notEmpty()
    .withMessage("Password is required.")
    .isLength({ max: 128 }),
  handleValidationErrors,
];

// ═══════════════════════════════════════════════════════════════════════════════
// Address Validators
// ═══════════════════════════════════════════════════════════════════════════════

const validateAddress = [
  body("houseNo")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("House/Flat number is required.")
    .isLength({ max: 100 }),
  body("street")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Street is required.")
    .isLength({ max: 500 }),
  body("city")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("City is required.")
    .isLength({ max: 100 }),
  body("state")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("State is required.")
    .isLength({ max: 100 }),
  body("zip")
    .isString()
    .trim()
    .notEmpty()
    .withMessage("Pincode is required.")
    .matches(/^[0-9A-Za-z\s-]{3,10}$/)
    .withMessage("Invalid pincode format."),
  body("label")
    .optional()
    .isString()
    .trim()
    .isLength({ max: 50 }),
  body("country")
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 }),
  body("landmark")
    .optional()
    .isString()
    .trim()
    .isLength({ max: 200 }),
  handleValidationErrors,
];

module.exports = {
  validateCreateOrder,
  validateVerifyPayment,
  validateRegister,
  validateLogin,
  validateAddress,
  handleValidationErrors,
};
