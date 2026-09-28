// ─────────────────────────────────────────────────────────────────────────────
// controllers/paymentController.js
//
// AMBIENCE — Razorpay Payment Gateway Controller (Production-Hardened)
//
// Three endpoints:
//   1. createOrder    — Creates a Razorpay order + saves a pending Order in MongoDB
//   2. verifyPayment  — Server-side HMAC-SHA256 signature verification
//   3. getMyOrders    — Returns authenticated user's order history
//
// SECURITY PRINCIPLES:
//   • No raw financial data (card numbers, CVVs) ever touches this server
//   • Signature verification is ALWAYS server-side (crypto.createHmac)
//   • The frontend NEVER computes hashes — it only forwards Razorpay tokens
//   • All routes are JWT-protected via the `protect` middleware
//   • The paymentGuard middleware blocks any raw card data in requests
//   • Idempotent verification — duplicate calls return existing result
//   • Demo mode locked behind NODE_ENV !== 'production'
//   • Server-side price validation against Product collection
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");
const Razorpay = require("razorpay");
const Order = require("../models/Order");
const Product = require("../models/Product");

// ═══════════════════════════════════════════════════════════════════════════════
// Razorpay Instance
//
// Reads credentials from environment variables.
// NEVER hardcode keys — they live in .env only.
// ═══════════════════════════════════════════════════════════════════════════════
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const IS_PRODUCTION = process.env.NODE_ENV === "production";

let razorpayInstance = null;

if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  razorpayInstance = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET,
  });
  console.log(`  ✅  Razorpay initialized (${IS_PRODUCTION ? "LIVE Mode" : "Test Mode"})`);
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
// SECURITY:
//   • In production, demo mode is DISABLED (cannot bypass payment)
//   • Server-side price validation: prices are looked up from Product collection
//     when possible, falling back to client prices only for unmatched products
//   • All amounts are recalculated server-side
// ═══════════════════════════════════════════════════════════════════════════════
const createOrder = async (req, res) => {
  try {
    // ── Check Demo Mode vs Real Razorpay ────────────────────────────────────
    const isDemoMode = !razorpayInstance;

    // ── SECURITY: Block demo mode in production ─────────────────────────────
    if (isDemoMode && IS_PRODUCTION) {
      console.error("[PAYMENT] ⛔ Demo mode blocked in production");
      return res.status(503).json({
        success: false,
        error: "Payment gateway is not configured. Please contact support.",
        code: "PAYMENT_NOT_CONFIGURED",
      });
    }

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

    // ── Server-side price validation ────────────────────────────────────────
    // Look up product prices from MongoDB to prevent client-side price tampering.
    // If a product is found in the DB, its DB price is used. Otherwise, the
    // client-provided price is trusted (for products not yet in the collection).
    const productIds = items
      .map((item) => item.productId || item.id)
      .filter((id) => id && id !== "unknown");

    let dbProducts = {};
    if (productIds.length > 0) {
      try {
        const products = await Product.find({
          $or: [
            { _id: { $in: productIds } },
            { productId: { $in: productIds } },
          ],
        }).lean();

        products.forEach((p) => {
          const id = p.productId || p._id.toString();
          dbProducts[id] = p;
        });
      } catch (dbErr) {
        // If product lookup fails, log and continue with client prices
        console.warn(`[PAYMENT] ⚠️ Product price lookup failed: ${dbErr.message}`);
      }
    }

    // ── Calculate amounts using validated prices ────────────────────────────
    const validatedItems = items.map((item) => {
      const productId = item.productId || item.id || "unknown";
      const dbProduct = dbProducts[productId];

      // Use DB price if available, otherwise trust client price
      let verifiedPrice = item.priceINR;
      if (dbProduct && typeof dbProduct.priceINR === "number") {
        verifiedPrice = dbProduct.priceINR;
        if (Math.abs(verifiedPrice - item.priceINR) > 0.01) {
          console.warn(
            `[PAYMENT] ⚠️ Price mismatch for "${item.name}": ` +
            `client=${item.priceINR}, DB=${verifiedPrice} — using DB price`
          );
        }
      }

      return {
        ...item,
        priceINR: verifiedPrice,
        productId,
      };
    });

    const subtotalINR = validatedItems.reduce(
      (sum, item) => sum + item.priceINR * item.qty, 0
    );
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
      items: validatedItems.map((item) => ({
        productId: item.productId,
        name: item.name,
        brand: item.brand || "",
        category: item.category || "",
        priceINR: item.priceINR,
        qty: item.qty,
        imageUrl: item.imageUrl || item.image || "",
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
// SECURITY ENHANCEMENTS:
//   • Idempotency guard — if order is already "Success", returns existing result
//   • Demo mode blocked in production
//   • Uses crypto.timingSafeEqual to prevent timing attacks
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

    // ── SECURITY: Block demo verification in production ─────────────────────
    if (isDemoMode && IS_PRODUCTION) {
      console.error(
        `[PAYMENT] ⛔ Demo payment verification BLOCKED in production | ` +
        `IP: ${req.ip} | User: ${req.user.email}`
      );
      return res.status(400).json({
        success: false,
        error: "Demo payments are not allowed in production.",
        code: "DEMO_BLOCKED",
      });
    }

    // ── Guard: Razorpay must be configured (if not demo) ────────────────────
    if (!isDemoMode && !RAZORPAY_KEY_SECRET) {
      return res.status(503).json({
        success: false,
        error: "Payment verification service is not configured.",
        code: "PAYMENT_NOT_CONFIGURED",
      });
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

    // ── IDEMPOTENCY GUARD: Already processed? Return existing result ────────
    if (order.paymentStatus === "Success") {
      console.log(
        `[PAYMENT] ℹ️ Duplicate verification for already-paid order: ${order.orderId} | ` +
        `User: ${req.user.email} — returning existing result`
      );
      return res.status(200).json({
        success: true,
        message: "Payment already verified.",
        order: order.toSafeObject(),
      });
    }

    if (order.paymentStatus === "Failed") {
      return res.status(400).json({
        success: false,
        error: "This payment has already been marked as failed.",
        code: "PAYMENT_ALREADY_FAILED",
      });
    }

    let isSignatureValid = false;

    if (isDemoMode) {
      // Automatically approve demo mode payments (dev only)
      isSignatureValid = true;
    } else {
      // ── Server-side signature verification (HMAC-SHA256) ────────────────────
      const body = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac("sha256", RAZORPAY_KEY_SECRET)
        .update(body)
        .digest("hex");

      try {
        isSignatureValid = crypto.timingSafeEqual(
          Buffer.from(expectedSignature, "hex"),
          Buffer.from(razorpay_signature, "hex")
        );
      } catch (bufferErr) {
        // Buffer length mismatch → invalid signature
        isSignatureValid = false;
      }
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
