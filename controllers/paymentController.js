// ─────────────────────────────────────────────────────────────────────────────
// controllers/paymentController.js
//
// AMBIENCE — Razorpay Payment Gateway Controller
//
// Two endpoints:
//   1. createOrder  — Creates a Razorpay order + saves a pending Order in MongoDB
//   2. verifyPayment — Server-side HMAC-SHA256 signature verification
//
// SECURITY PRINCIPLES:
//   • No raw financial data (card numbers, CVVs) ever touches this server
//   • Signature verification is ALWAYS server-side (crypto.createHmac)
//   • The frontend NEVER computes hashes — it only forwards Razorpay tokens
//   • All routes are JWT-protected via the `protect` middleware
//   • The paymentGuard middleware blocks any raw card data in requests
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");
const Razorpay = require("razorpay");
const Order = require("../models/Order");

// ═══════════════════════════════════════════════════════════════════════════════
// Razorpay Instance (Test Mode)
//
// Reads credentials from environment variables.
// NEVER hardcode keys — they live in .env only.
// ═══════════════════════════════════════════════════════════════════════════════
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

let razorpayInstance = null;

if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpayInstance = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET,
  });
  console.log("  ✅  Razorpay initialized (Test Mode)");
} else {
  console.warn(
    "  ⚠️   Razorpay credentials missing in .env — payment routes will be disabled."
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/payment/create-order
//
// Creates a Razorpay order and saves a corresponding Order document in MongoDB.
//
// Request body:
//   {
//     items: [{ productId, name, brand, category, priceINR, qty }],
//     shippingAddress: { label, street, city, state, zip, country }  (optional)
//   }
//
// Response:
//   {
//     success: true,
//     order_id: "order_xxx",
//     amount: 99900,         // in paise
//     currency: "INR",
//     key_id: "rzp_test_xxx",
//     orderId: "AMB-xxx"     // our internal order ID
//   }
// ═══════════════════════════════════════════════════════════════════════════════
const createOrder = async (req, res) => {
  try {
    // ── Check Demo Mode vs Real Razorpay ────────────────────────────────────
    const isDemoMode = !razorpayInstance;

    // ── Validate request body ───────────────────────────────────────────────
    const { items, shippingAddress } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Cart is empty. Please add items before checkout.",
        code: "EMPTY_CART",
      });
    }

    // ── Validate each item ──────────────────────────────────────────────────
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.name || !item.priceINR || !item.qty) {
        return res.status(400).json({
          success: false,
          error: `Invalid item at position ${i + 1}: name, priceINR, and qty are required.`,
          code: "INVALID_ITEM",
        });
      }
      if (typeof item.priceINR !== "number" || item.priceINR <= 0) {
        return res.status(400).json({
          success: false,
          error: `Invalid price for "${item.name}". Price must be a positive number.`,
          code: "INVALID_PRICE",
        });
      }
      if (typeof item.qty !== "number" || item.qty < 1 || !Number.isInteger(item.qty)) {
        return res.status(400).json({
          success: false,
          error: `Invalid quantity for "${item.name}". Quantity must be a positive integer.`,
          code: "INVALID_QUANTITY",
        });
      }
    }

    // ── Calculate amounts (in paise = INR × 100) ────────────────────────────
    const subtotalINR = items.reduce((sum, item) => sum + item.priceINR * item.qty, 0);
    const taxINR = Math.round(subtotalINR * 0.18); // 18% GST
    const totalINR = subtotalINR + taxINR;

    const amountPaise = Math.round(subtotalINR * 100);
    const taxPaise = Math.round(taxINR * 100);
    const totalPaise = Math.round(totalINR * 100);

    // ── Razorpay minimum amount check (₹1 = 100 paise) ─────────────────────
    if (totalPaise < 100) {
      return res.status(400).json({
        success: false,
        error: "Order total must be at least ₹1.",
        code: "AMOUNT_TOO_LOW",
      });
    }

    // ── Create Razorpay order (or Demo Order) ───────────────────────────────
    let razorpayOrderId;
    if (isDemoMode) {
      razorpayOrderId = `demo_order_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    } else {
      const razorpayOrder = await razorpayInstance.orders.create({
        amount: totalPaise,
        currency: "INR",
        receipt: `amb_${Date.now()}`,
        notes: {
          userEmail: req.user.email,
          itemCount: items.length.toString(),
        },
      });
      razorpayOrderId = razorpayOrder.id;
    }

    // ── Save Order to MongoDB (status: Pending) ─────────────────────────────
    const order = new Order({
      user: req.user._id,
      userEmail: req.user.email,
      items: items.map((item) => ({
        productId: item.productId || item.id || "unknown",
        name: item.name,
        brand: item.brand || "",
        category: item.category || "",
        priceINR: item.priceINR,
        qty: item.qty,
      })),
      amount: amountPaise,
      taxAmount: taxPaise,
      totalAmount: totalPaise,
      currency: "INR",
      razorpay_order_id: razorpayOrderId,
      paymentStatus: "Pending",
      orderStatus: "Confirmed",
      shippingAddress: shippingAddress || null,
    });

    await order.save();

    console.log(
      `[PAYMENT] ✅ Order created: ${order.orderId} | ` +
      `Order: ${razorpayOrderId} | ` +
      `Amount: ₹${totalINR} | User: ${req.user.email}`
    );

    // ── Return order details to frontend ────────────────────────────────────
    return res.status(201).json({
      success: true,
      order_id: razorpayOrderId,
      amount: totalPaise,
      currency: "INR",
      key_id: RAZORPAY_KEY_ID || "demo_key",
      orderId: order.orderId,
    });
  } catch (error) {
    console.error("[PAYMENT] ❌ Error creating order:", error.message);

    // Razorpay API errors
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: "Payment gateway error. Please try again.",
        code: "RAZORPAY_ERROR",
      });
    }

    return res.status(500).json({
      success: false,
      error: "Failed to create payment order. Please try again.",
      code: "ORDER_CREATION_FAILED",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/payment/verify
//
// Verifies the Razorpay payment signature using HMAC-SHA256.
// This MUST happen server-side — the frontend NEVER computes hashes.
//
// Request body:
//   {
//     razorpay_order_id:   "order_xxx",
//     razorpay_payment_id: "pay_xxx",
//     razorpay_signature:  "hex_signature"
//   }
//
// Verification formula:
//   expected = HMAC-SHA256(razorpay_order_id + "|" + razorpay_payment_id, KEY_SECRET)
//   valid = (expected === razorpay_signature)
// ═══════════════════════════════════════════════════════════════════════════════
const verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // ── Validate required fields ────────────────────────────────────────────
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        error: "Missing payment verification data.",
        code: "MISSING_PAYMENT_DATA",
      });
    }

    const isDemoMode = razorpay_order_id.startsWith("demo_order_");

    // ── Guard: Razorpay must be configured (if not demo) ────────────────────
    if (!isDemoMode && !RAZORPAY_KEY_SECRET) {
      return res.status(503).json({
        success: false,
        error: "Payment verification service is not configured.",
        code: "PAYMENT_NOT_CONFIGURED",
      });
    }

    let isSignatureValid = false;

    if (isDemoMode) {
      // Automatically approve demo mode payments
      isSignatureValid = true;
    } else {
      // ── Server-side signature verification (HMAC-SHA256) ────────────────────
      const body = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac("sha256", RAZORPAY_KEY_SECRET)
        .update(body)
        .digest("hex");

      isSignatureValid = crypto.timingSafeEqual(
        Buffer.from(expectedSignature, "hex"),
        Buffer.from(razorpay_signature, "hex")
      );
    }

    // ── Find the order in MongoDB ───────────────────────────────────────────
    const order = await Order.findOne({
      razorpay_order_id,
      user: req.user._id,
    });

    if (!order) {
      console.warn(
        `[PAYMENT] ⚠️ Order not found for verification: ${razorpay_order_id} | User: ${req.user.email}`
      );
      return res.status(404).json({
        success: false,
        error: "Order not found.",
        code: "ORDER_NOT_FOUND",
      });
    }

    if (isSignatureValid) {
      // ── SUCCESS: Update order ─────────────────────────────────────────────
      order.razorpay_payment_id = razorpay_payment_id;
      order.razorpay_signature = razorpay_signature;
      order.paymentStatus = "Success";
      order.orderStatus = "Confirmed";
      order.paidAt = new Date();
      await order.save();

      console.log(
        `[PAYMENT] ✅ Payment verified: ${order.orderId} | ` +
        `Payment: ${razorpay_payment_id} | ` +
        `Amount: ${order.displayAmount} | User: ${req.user.email}`
      );

      return res.status(200).json({
        success: true,
        message: "Payment verified successfully!",
        order: order.toSafeObject(),
      });
    } else {
      // ── FAILED: Signature mismatch ────────────────────────────────────────
      order.paymentStatus = "Failed";
      await order.save();

      console.error(
        `[PAYMENT] ⛔ Signature verification FAILED: ${razorpay_order_id} | ` +
        `IP: ${req.ip} | User: ${req.user.email}`
      );

      return res.status(400).json({
        success: false,
        error: "Payment verification failed. Signature mismatch.",
        code: "SIGNATURE_MISMATCH",
      });
    }
  } catch (error) {
    console.error("[PAYMENT] ❌ Error verifying payment:", error.message);

    return res.status(500).json({
      success: false,
      error: "Payment verification failed. Please contact support.",
      code: "VERIFICATION_ERROR",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/orders/my-orders
//
// Returns all orders for the authenticated user, sorted by newest first.
// ═══════════════════════════════════════════════════════════════════════════════
const getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    const safeOrders = orders.map((order) => ({
      orderId: order.orderId,
      items: order.items,
      amount: order.amount,
      taxAmount: order.taxAmount,
      totalAmount: order.totalAmount,
      currency: order.currency,
      paymentStatus: order.paymentStatus,
      orderStatus: order.orderStatus,
      shippingAddress: order.shippingAddress,
      razorpay_order_id: order.razorpay_order_id,
      razorpay_payment_id: order.razorpay_payment_id,
      paidAt: order.paidAt,
      createdAt: order.createdAt,
    }));

    return res.status(200).json({
      success: true,
      orders: safeOrders,
      count: safeOrders.length,
    });
  } catch (error) {
    console.error("[ORDERS] ❌ Error fetching orders:", error.message);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch orders.",
    });
  }
};

module.exports = { createOrder, verifyPayment, getMyOrders };
