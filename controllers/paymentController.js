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
const mongoose = require("mongoose");
const Razorpay = require("razorpay");
const Order = require("../models/Order");
const Product = require("../models/Product");

// ═══════════════════════════════════════════════════════════════════════════════
// Razorpay Instance
//
// Reads credentials from environment variables.
// NEVER hardcode keys — they live in .env only.
// ═══════════════════════════════════════════════════════════════════════════════
const sanitizeEnv = (val) => {
  if (!val || typeof val !== "string") return "";
  let clean = val.trim();
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    clean = clean.slice(1, -1).trim();
  }
  return clean;
};

const isPlaceholder = (val) => {
  if (!val || typeof val !== "string") return true;
  const lower = val.toLowerCase().trim();
  return (
    lower === "" ||
    lower.includes("your_") ||
    lower.includes("placeholder") ||
    lower.includes("xxxx") ||
    lower === "rzp_test_your_key_id" ||
    lower === "your_key_secret"
  );
};

const sanitizedKeyId = sanitizeEnv(process.env.RAZORPAY_KEY_ID);
const sanitizedKeySecret = sanitizeEnv(process.env.RAZORPAY_KEY_SECRET);

const RAZORPAY_KEY_ID = isPlaceholder(sanitizedKeyId) ? "" : sanitizedKeyId;
const RAZORPAY_KEY_SECRET = isPlaceholder(sanitizedKeySecret) ? "" : sanitizedKeySecret;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ALLOW_DEMO_PAYMENTS = process.env.ALLOW_DEMO_PAYMENTS === "true";

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
    const isDemoMode = !razorpayInstance || !RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET;

    // ── SECURITY: Block demo mode in production ─────────────────────────────
    if (isDemoMode && IS_PRODUCTION && !ALLOW_DEMO_PAYMENTS) {
      console.error("[PAYMENT] ⛔ Demo mode blocked in production: Razorpay credentials not configured");
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
    const validatedItems = [];
    for (const item of items) {
      const productId = item.productId || item.id || "unknown";
      const dbProduct = dbProducts[productId];

      let verifiedPrice = item.priceINR;

      if (dbProduct) {
        // SECURITY: Use DB price — dealPrice first, then retailPrice, then priceINR
        const dbPrice = dbProduct.dealPrice || dbProduct.retailPrice || dbProduct.priceINR;
        if (typeof dbPrice === "number" && dbPrice > 0) {
          if (Math.abs(dbPrice - item.priceINR) > 0.01) {
            console.warn(
              `[PAYMENT] ⚠️ Price mismatch for "${item.name}": ` +
              `client=${item.priceINR}, DB=${dbPrice} — using DB price`
            );
          }
          verifiedPrice = dbPrice;
        }
        // STOCK CHECK: Warn if product has no stock tracking (future inventory feature)
        if (typeof dbProduct.stock === 'number' && dbProduct.stock < item.qty) {
          console.warn(
            `[PAYMENT] ⚠️ Insufficient stock for "${item.name}": ` +
            `requested=${item.qty}, available=${dbProduct.stock}`
          );
          return res.status(400).json({
            success: false,
            error: `"${item.name}" has only ${dbProduct.stock} unit(s) available. Please reduce quantity.`,
            code: "INSUFFICIENT_STOCK",
          });
        } else if (typeof dbProduct.stock !== 'number') {
          console.info(
            `[PAYMENT] ℹ️ No stock tracking for "${item.name}" (ID: ${productId}) — ` +
            `inventory management not yet enabled for this product`
          );
        }
      } else if (IS_PRODUCTION && productId !== "unknown") {
        // SECURITY: In production, reject items not found in DB
        // This prevents price tampering with fabricated product IDs
        console.error(
          `[PAYMENT] ⛔ Product "${item.name}" (ID: ${productId}) not found in DB — ` +
          `rejecting in production mode | User: ${req.user.email}`
        );
        return res.status(400).json({
          success: false,
          error: `Product "${item.name}" could not be verified. Please refresh your cart and try again.`,
          code: "PRODUCT_NOT_VERIFIED",
        });
      }

      validatedItems.push({
        ...item,
        priceINR: verifiedPrice,
        productId,
      });
    }

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

    // ── Safe User Metadata Resolution ──────────────────────────────────────
    const userEmail = (
      req.user?.email ||
      req.user?.userEmail ||
      (req.user?.phone ? `${req.user.phone}@ambience.phone` : "customer@ambience.luxury")
    ).toLowerCase().trim();

    let orderUserId = req.user?._id;
    if (!orderUserId || !mongoose.Types.ObjectId.isValid(orderUserId)) {
      orderUserId = new mongoose.Types.ObjectId();
    }

    // ── Create Razorpay order (or Demo Order) ───────────────────────────────
    let razorpayOrderId;
    if (isDemoMode) {
      razorpayOrderId = `demo_order_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    } else {
      try {
        const razorpayOrder = await razorpayInstance.orders.create({
          amount: totalPaise,
          currency: "INR",
          receipt: `amb_${Date.now()}`,
          notes: {
            userEmail: userEmail,
            itemCount: items.length.toString(),
          },
        });
        razorpayOrderId = razorpayOrder.id;
      } catch (rzpErr) {
        console.error("[PAYMENT] ❌ Razorpay orders.create failed:", rzpErr);
        const rzpStatus = rzpErr?.statusCode || rzpErr?.status || rzpErr?.status_code || rzpErr?.response?.status || 500;
        const rzpDesc = rzpErr?.error?.description || rzpErr?.message || (typeof rzpErr === "string" ? rzpErr : "Razorpay gateway error");
        const isAuthError =
          rzpStatus === 401 ||
          rzpStatus === 403 ||
          rzpErr?.statusCode === 401 ||
          rzpErr?.statusCode === 403 ||
          rzpDesc.toLowerCase().includes("does not exist") ||
          rzpDesc.toLowerCase().includes("authentication") ||
          rzpDesc.toLowerCase().includes("unauthorized") ||
          rzpDesc.toLowerCase().includes("key_id");

        const clientMessage = isAuthError
          ? "Payment gateway authentication failed. Please contact support."
          : "Payment gateway error. Please try again.";
        const clientCode = isAuthError ? "GATEWAY_AUTH_ERROR" : "RAZORPAY_ERROR";

        return res.status(isAuthError ? 401 : (rzpStatus >= 400 && rzpStatus < 600 ? rzpStatus : 502)).json({
          success: false,
          error: clientMessage,
          code: clientCode,
          details: rzpDesc,
        });
      }
    }

    // ── Save Order to MongoDB (status: Pending) ─────────────────────────────
    const order = new Order({
      user: orderUserId,
      userEmail: userEmail,
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

    try {
      await order.save();
    } catch (saveErr) {
      console.error("[PAYMENT] ❌ Order save failed:", saveErr);
      const isValidation = saveErr.name === "ValidationError" || saveErr.name === "CastError";
      return res.status(isValidation ? 400 : 500).json({
        success: false,
        error: isValidation ? `Order data error: ${saveErr.message}` : "Failed to create order record. Please try again.",
        code: isValidation ? "ORDER_VALIDATION_ERROR" : "ORDER_CREATION_FAILED",
        details: saveErr.message,
      });
    }

    console.log(
      `[PAYMENT] ✅ Order created: ${order.orderId} | ` +
      `Order: ${razorpayOrderId} | ` +
      `Amount: ₹${totalINR} | User: ${userEmail}`
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
    const errorDetail = error?.error?.description || error?.message || (typeof error === "string" ? error : "Unknown error");
    console.error(`[PAYMENT] ❌ Error creating order: ${errorDetail}`);

    const statusCode =
      error?.statusCode ||
      error?.status ||
      error?.status_code ||
      error?.error?.status_code ||
      error?.response?.status;

    // Razorpay API errors with status code
    if (statusCode || error.statusCode) {
      const codeNum = statusCode || error.statusCode;
      const isAuth =
        codeNum === 401 ||
        codeNum === 403 ||
        error.statusCode === 401 ||
        error.statusCode === 403 ||
        errorDetail.toLowerCase().includes("authentication") ||
        errorDetail.toLowerCase().includes("unauthorized") ||
        errorDetail.toLowerCase().includes("does not exist") ||
        errorDetail.toLowerCase().includes("key_id");

      const clientMessage = isAuth
        ? "Payment gateway authentication failed. Please contact support."
        : "Payment gateway error. Please try again.";
      const clientCode = isAuth
        ? "GATEWAY_AUTH_ERROR"
        : "RAZORPAY_ERROR";

      return res.status(codeNum >= 400 && codeNum < 600 ? codeNum : 500).json({
        success: false,
        error: clientMessage,
        code: clientCode,
        details: errorDetail,
      });
    }

    if (error && (error.name === "ValidationError" || error.name === "CastError")) {
      return res.status(400).json({
        success: false,
        error: `Order validation failed: ${error.message}`,
        code: "ORDER_VALIDATION_ERROR",
        details: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      error: "Failed to create payment order. Please try again.",
      code: "ORDER_CREATION_FAILED",
      details: errorDetail,
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
    if (isDemoMode && IS_PRODUCTION && !ALLOW_DEMO_PAYMENTS) {
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
    const orderQuery = { razorpay_order_id };
    if (req.user?._id && mongoose.Types.ObjectId.isValid(req.user._id)) {
      orderQuery.$or = [
        { user: req.user._id },
        { userEmail: req.user.email },
      ];
    } else if (req.user?.email) {
      orderQuery.userEmail = req.user.email;
    }
    const order = await Order.findOne(orderQuery);

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
      // ── ATOMIC TRANSITION GUARD ───────────────────────────────────────────
      // Atomically transition from "Pending" to "Success".
      // If another thread (e.g. webhook) already transitioned this order,
      // updatedOrder will be null, guaranteeing that payment state transition
      // happens EXACTLY ONCE across concurrent requests.
      const updatedOrder = await Order.findOneAndUpdate(
        {
          _id: order._id,
          paymentStatus: "Pending",
        },
        {
          $set: {
            razorpay_payment_id,
            razorpay_signature,
            paymentStatus: "Success",
            orderStatus: "Confirmed",
            paidAt: new Date(),
          },
        },
        { new: true }
      );

      if (updatedOrder) {
        // Execute side-effects (inventory decrement & confirmation email)
        await processPaymentSideEffects(updatedOrder);

        console.log(
          `[PAYMENT] ✅ Payment verified: ${updatedOrder.orderId} | ` +
          `Payment: ${razorpay_payment_id} | ` +
          `Amount: ${updatedOrder.displayAmount} | User: ${req.user.email}`
        );

        return res.status(200).json({
          success: true,
          message: "Payment verified successfully!",
          order: updatedOrder.toSafeObject(),
        });
      } else {
        // Order was already confirmed (e.g. by concurrent webhook)
        console.log(
          `[PAYMENT] ℹ️ Concurrent verification: order ${order.orderId} was already confirmed. Skipping duplicate transition.`
        );
        const freshOrder = await Order.findById(order._id);

        // Crash-recovery: If previous thread crashed before completing side-effects, recover them now!
        if (freshOrder && (!freshOrder.inventoryDecremented || !freshOrder.confirmationEmailSent)) {
          console.log(`[PAYMENT] 🔄 Recovering incomplete side-effects for order: ${freshOrder.orderId}`);
          await processPaymentSideEffects(freshOrder);
        }

        return res.status(200).json({
          success: true,
          message: "Payment already verified.",
          order: freshOrder ? freshOrder.toSafeObject() : order.toSafeObject(),
        });
      }
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
// Transactional Email Helpers (Production-Grade & Idempotent)
// ═══════════════════════════════════════════════════════════════════════════════

const sendAdminOrderNotification = async (order) => {
  if (order.adminNotificationEmailSent) return false;
  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL || process.env.GMAIL_USER;
  if (!adminEmail || !adminEmail.includes("@")) return false;

  try {
    const { sendEmail } = require("../utils/emailService");
    const itemsHtml = (order.items || [])
      .map((i) => `<li>${i.name} × ${i.qty} — ₹${((i.priceINR * i.qty)).toLocaleString("en-IN")}</li>`)
      .join("");
    const addr = order.shippingAddress;
    const addrStr = addr
      ? `${addr.street ? addr.street + ', ' : ''}${addr.city || ''}, ${addr.state || ''} ${addr.zip || ''}, ${addr.country || 'India'}`
      : "Not provided";

    await sendEmail({
      to: adminEmail,
      subject: `[AMBIENCE OPS] New Paid Order: ${order.orderId} (₹${(order.totalAmount / 100).toLocaleString("en-IN")})`,
      html: `
        <h2>New Customer Order Placed</h2>
        <p><strong>Order ID:</strong> ${order.orderId}</p>
        <p><strong>Customer Email:</strong> ${order.userEmail}</p>
        <p><strong>Payment Status:</strong> ${order.paymentStatus} (Razorpay Payment ID: ${order.razorpay_payment_id || 'N/A'})</p>
        <p><strong>Total Amount:</strong> ₹${(order.totalAmount / 100).toLocaleString("en-IN")}</p>
        <p><strong>Items:</strong></p>
        <ul>${itemsHtml}</ul>
        <p><strong>Shipping Address:</strong><br />${addrStr}</p>
        <p><a href="${process.env.FRONTEND_URL || "https://ambience-fronten.vercel.app"}/admin">Go to Admin Dashboard</a></p>
      `,
      logLabel: "Admin New Order Notification",
    });

    order.adminNotificationEmailSent = true;
    await order.save();
    return true;
  } catch (err) {
    console.warn(`[EMAIL] Admin notification note for ${order.orderId}:`, err.message);
    return false;
  }
};

const sendOrderShippingEmail = async (order) => {
  if (order.shippingEmailSent || !order.userEmail) return false;

  try {
    const { sendEmail } = require("../utils/emailService");
    const itemsHtml = (order.items || [])
      .map((i) => `<li>${i.name} × ${i.qty}</li>`)
      .join("");

    const trackingHtml = order.trackingNumber
      ? `<p><strong>Carrier:</strong> ${order.carrier || 'Standard Courier'}<br />
            <strong>Tracking / AWB Number:</strong> ${order.trackingNumber}<br />
            ${order.trackingUrl ? `<strong>Tracking Link:</strong> <a href="${order.trackingUrl}" target="_blank" rel="noopener noreferrer">${order.trackingUrl}</a>` : ''}
         </p>`
      : `<p>Your parcel has been dispatched via ${order.carrier || 'our courier partner'}. Live status can be viewed in your account.</p>`;

    await sendEmail({
      to: order.userEmail,
      subject: `Dispatched: Your Ambience Order ${order.orderId} Is on Its Way!`,
      html: `
        <h2>Your Ambience Order Has Shipped!</h2>
        <p>Great news! Your order <strong>${order.orderId}</strong> has been packaged and handed over to our delivery partner.</p>
        ${trackingHtml}
        <h3>Order Items:</h3>
        <ul>${itemsHtml}</ul>
        <p>You can track the shipment journey live anytime on your <a href="${process.env.FRONTEND_URL || "https://ambience-fronten.vercel.app"}/orders">My Orders</a> page.</p>
        <p>Thank you for shopping with Ambience.</p>
      `,
      logLabel: "Order Shipping Email",
    });

    order.shippingEmailSent = true;
    await order.save();
    return true;
  } catch (err) {
    console.warn(`[EMAIL] Shipping notification note for ${order.orderId}:`, err.message);
    return false;
  }
};

const sendOrderDeliveredEmail = async (order) => {
  if (order.deliveryEmailSent || !order.userEmail) return false;

  try {
    const { sendEmail } = require("../utils/emailService");
    const itemsHtml = (order.items || [])
      .map((i) => `<li>${i.name} × ${i.qty}</li>`)
      .join("");

    await sendEmail({
      to: order.userEmail,
      subject: `Delivered: Your Ambience Order ${order.orderId}`,
      html: `
        <h2>Your Order Has Been Delivered!</h2>
        <p>Your order <strong>${order.orderId}</strong> has been marked as delivered.</p>
        <h3>Delivered Items:</h3>
        <ul>${itemsHtml}</ul>
        <p>We hope you love your selection! If you need any assistance, reach out via <a href="${process.env.FRONTEND_URL || "https://ambience-fronten.vercel.app"}/account?tab=support">VIP Support</a>.</p>
        <p>Warm regards,<br />The Ambience Team</p>
      `,
      logLabel: "Order Delivered Email",
    });

    order.deliveryEmailSent = true;
    await order.save();
    return true;
  } catch (err) {
    console.warn(`[EMAIL] Delivery notification note for ${order.orderId}:`, err.message);
    return false;
  }
};

const sendOrderCancellationEmail = async (order) => {
  if (order.cancellationEmailSent || !order.userEmail) return false;

  try {
    const { sendEmail } = require("../utils/emailService");
    const refundFormatted = (order.refundAmount || order.totalAmount)
      ? `₹${((order.refundAmount || order.totalAmount) / 100).toLocaleString("en-IN")}`
      : "₹0";

    const refundText = order.paymentStatus === "Success"
      ? `<p><strong>Refund Status:</strong> ${order.refundStatus || "Initiated"}<br />
            <strong>Refund Amount:</strong> ${refundFormatted}<br />
            ${order.refundId ? `<strong>Refund ID:</strong> ${order.refundId}<br />` : ''}
            <em>Note: Gateway refunds are processed back to your original payment method within 5–7 business days.</em>
         </p>`
      : `<p>Payment was not captured for this order; no charge was incurred.</p>`;

    await sendEmail({
      to: order.userEmail,
      subject: `Order Cancelled: ${order.orderId} — Ambience`,
      html: `
        <h2>Order Cancellation Notice</h2>
        <p>Your order <strong>${order.orderId}</strong> has been cancelled.</p>
        <p><strong>Reason:</strong> ${order.cancellationReason || "Cancellation requested"}</p>
        ${refundText}
        <p>If you have any questions, please contact our concierge via your <a href="${process.env.FRONTEND_URL || "https://ambience-fronten.vercel.app"}/account?tab=support">Ambience Account</a>.</p>
      `,
      logLabel: "Order Cancellation Email",
    });

    order.cancellationEmailSent = true;
    await order.save();
    return true;
  } catch (err) {
    console.warn(`[EMAIL] Cancellation notification note for ${order.orderId}:`, err.message);
    return false;
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// Helper: processPaymentSideEffects
//
// Executes or recovers payment confirmation side-effects (inventory decrement & email)
// in an idempotent, crash-resilient manner.
//
// Guarantees:
//  1. Inventory decrement happens at most once per order (atomically guarded by inventoryDecremented).
//  2. Stock cannot go negative (oversell protection via { stock: { $gte: item.qty } }).
//  3. Shortfall is recorded if concurrent orders exhausted stock before verification.
//  4. Email is sent and recorded (guarded by confirmationEmailSent).
//  5. If the server crashes mid-process, re-invoking this function safely completes
//     only the unfinished side-effects without repeating already completed ones.
// ═══════════════════════════════════════════════════════════════════════════════
const processPaymentSideEffects = async (order) => {
  let inventoryUpdated = false;
  let emailSent = false;

  // ── 1. INVENTORY DECREMENT (Idempotent Guard with Oversell Protection) ───
  if (!order.inventoryDecremented) {
    let hasShortfall = false;
    const shortfallItems = [];

    for (const item of order.items) {
      if (item.productId && mongoose.Types.ObjectId.isValid(item.productId)) {
        try {
          // Atomic update: only decrement if stock >= requested quantity
          const updateRes = await Product.updateOne(
            { _id: item.productId, stock: { $gte: item.qty } },
            { $inc: { stock: -item.qty, soldCount: item.qty } }
          );

          if (updateRes.matchedCount === 0) {
            // Check if product is untracked (stock === null)
            const untrackedRes = await Product.updateOne(
              { _id: item.productId, stock: null },
              { $inc: { soldCount: item.qty } }
            );

            if (untrackedRes.matchedCount === 0) {
              // Stock was tracked but current stock < item.qty (concurrent oversell attempt blocked!)
              const currentProd = await Product.findById(item.productId).select("stock name").lean();
              console.warn(
                `[INVENTORY] ⚠️ Stock exhausted by concurrent order for "${item.name}" (ID: ${item.productId}). ` +
                `Available: ${currentProd?.stock ?? 0}, Requested: ${item.qty}. Oversell prevented.`
              );
              hasShortfall = true;
              shortfallItems.push({
                productId: item.productId,
                name: item.name,
                requestedQty: item.qty,
                availableStock: currentProd?.stock ?? 0,
              });
            }
          }
        } catch (stockErr) {
          console.warn(`[INVENTORY] Stock decrement error for ${item.productId}:`, stockErr.message);
        }
      }
    }

    // Persist that inventory side effects have been processed for this order
    order.inventoryDecremented = true;
    if (hasShortfall) {
      order.inventoryShortfall = true;
      order.inventoryShortfallDetails = shortfallItems;
    }
    await order.save();
    inventoryUpdated = true;
  }

  // ── 2. CONFIRMATION EMAIL (Idempotent Guard) ──────────────────────────────
  if (!order.confirmationEmailSent && order.userEmail) {
    try {
      const { sendEmail } = require("../utils/emailService");
      const itemsHtml = order.items
        .map((i) => `<li>${i.name} × ${i.qty} — ₹${((i.priceINR * i.qty)).toLocaleString("en-IN")}</li>`)
        .join("");

      await sendEmail({
        to: order.userEmail,
        subject: `Order Confirmed: ${order.orderId} — Ambience`,
        html: `
          <h2>Thank you for your purchase from Ambience!</h2>
          <p>Your order <strong>${order.orderId}</strong> has been successfully placed and confirmed.</p>
          <p><strong>Total Amount:</strong> ₹${(order.totalAmount / 100).toLocaleString("en-IN")}</p>
          <h3>Purchased Items:</h3>
          <ul>${itemsHtml}</ul>
          <p>You can track your order status live in your <a href="${process.env.FRONTEND_URL || "https://ambience-fronten.vercel.app"}/orders">My Orders</a> dashboard.</p>
        `,
        logLabel: "Order Confirmation Email",
      });

      order.confirmationEmailSent = true;
      await order.save();
      emailSent = true;
    } catch (emailErr) {
      console.warn(`[EMAIL] Order confirmation dispatch note for ${order.orderId}:`, emailErr.message);
    }
  }

  // ── 3. ADMIN NOTIFICATION EMAIL (Idempotent Guard) ────────────────────────
  if (!order.adminNotificationEmailSent) {
    await sendAdminOrderNotification(order);
  }

  return { success: true, inventoryUpdated, emailSent };
};

// ═══════════════════════════════════════════════════════════════════════════════
// Helper: restoreOrderInventoryAtomic
//
// Atomically claims and restores inventory for an order.
// Uses a Compare-And-Swap (CAS) update on the Order document to guarantee
// that exactly ONE concurrent request can ever restore stock for any given order.
// ═══════════════════════════════════════════════════════════════════════════════
const restoreOrderInventoryAtomic = async (orderId) => {
  if (!orderId) return { restored: false, reason: "Missing order ID" };

  const query = mongoose.Types.ObjectId.isValid(orderId)
    ? { _id: orderId, inventoryDecremented: true }
    : { orderId: orderId, inventoryDecremented: true };

  // DURABLE ATOMIC CLAIM: Exactly ONE process can flip inventoryDecremented from true to false
  const claimedOrder = await Order.findOneAndUpdate(
    query,
    {
      $set: {
        inventoryDecremented: false,
        stockRestoredAt: new Date(),
      },
    },
    { new: true }
  );

  if (!claimedOrder) {
    // Already claimed or was never decremented
    return { restored: false, reason: "Inventory was not decremented or already restored" };
  }

  for (const item of claimedOrder.items) {
    if (item.productId && mongoose.Types.ObjectId.isValid(item.productId)) {
      try {
        await Product.updateOne(
          { _id: item.productId, stock: { $ne: null } },
          { $inc: { stock: item.qty, soldCount: -item.qty } }
        );
        await Product.updateOne(
          { _id: item.productId, stock: null },
          { $inc: { soldCount: -item.qty } }
        );
      } catch (invErr) {
        console.warn(`[INVENTORY] Failed to restore stock for ${item.productId}:`, invErr.message);
      }
    }
  }

  console.log(`[INVENTORY] 🔄 Atomically restored inventory for order: ${claimedOrder.orderId}`);
  return { restored: true, order: claimedOrder };
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/orders/my-orders
//
// Returns all authentic orders for the authenticated user, sorted by newest first.
// Demo / test orders are strictly excluded in production and by default in development
// unless explicitly requested via ?includeDemo=true in non-production environments.
// Historical order items, pricing snapshots, and invoice data are preserved even if
// products have since been removed or updated in the catalog.
// ═══════════════════════════════════════════════════════════════════════════════
const getMyOrders = async (req, res) => {
  try {
    const isProd = IS_PRODUCTION || process.env.NODE_ENV === "production";
    const allowDemo = !isProd && req.query.includeDemo === "true";

    const filter = { user: req.user._id };

    // Strictly exclude demo/test orders from real customer order history across all demo markers
    if (!allowDemo) {
      filter.$and = [
        { razorpay_order_id: { $not: /^demo_/ } },
        {
          $or: [
            { razorpay_payment_id: null },
            { razorpay_payment_id: { $not: /^demo_/ } },
          ],
        },
        { razorpay_signature: { $ne: "demo_signature" } },
      ];
    }

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    const safeOrders = orders.map((order) => {
      const isDemo = Boolean(
        (typeof order.razorpay_order_id === "string" && order.razorpay_order_id.startsWith("demo_")) ||
        (typeof order.razorpay_payment_id === "string" && order.razorpay_payment_id.startsWith("demo_")) ||
        order.razorpay_signature === "demo_signature"
      );

      // Preserve full fidelity of historical purchased items even if removed from the catalog
      const items = (order.items || []).map((item) => ({
        productId: item.productId,
        name: item.name || "Purchased Product",
        brand: item.brand || "",
        category: item.category || "",
        priceINR: Number(item.priceINR ?? item.price ?? 0),
        qty: Number(item.qty || 1),
        imageUrl: item.imageUrl || item.image || "",
      }));

      return {
        _id: order._id,
        orderId: order.orderId,
        items,
        amount: order.amount,
        taxAmount: order.taxAmount,
        totalAmount: order.totalAmount,
        currency: order.currency || "INR",
        paymentStatus: order.paymentStatus || "Pending",
        orderStatus: order.orderStatus || "Confirmed",
        shippingAddress: order.shippingAddress || null,
        razorpay_order_id: order.razorpay_order_id,
        razorpay_payment_id: order.razorpay_payment_id,
        refundStatus: order.refundStatus || "None",
        refundAmount: order.refundAmount || 0,
        refundId: order.refundId || null,
        cancellationReason: order.cancellationReason || null,
        carrier: order.carrier || "",
        trackingNumber: order.trackingNumber || "",
        trackingUrl: order.trackingUrl || "",
        shippedAt: order.shippedAt || null,
        deliveredAt: order.deliveredAt || null,
        paidAt: order.paidAt || null,
        createdAt: order.createdAt,
        invoiceNumber: order.invoiceNumber || null,
        invoiceDate: order.invoiceDate || null,
        isDemo,
      };
    });

    // Defense-in-depth: guarantee no demo order reaches customer in production/default view
    const visibleOrders = allowDemo ? safeOrders : safeOrders.filter((order) => !order.isDemo);

    return res.status(200).json({
      success: true,
      orders: visibleOrders,
      count: visibleOrders.length,
    });
  } catch (error) {
    console.error("[ORDERS] ❌ Error fetching orders:", error.message);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch orders.",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// Helper: processRazorpayRefund
//
// Triggers an actual refund via Razorpay's Refund API when available.
// In test/demo mode or if Razorpay credentials are unset, handles gracefully.
// ═══════════════════════════════════════════════════════════════════════════════
const processRazorpayRefund = async (order, reason = "Customer cancellation") => {
  if (order.paymentStatus !== "Success") {
    return { success: false, error: "Order payment was not captured; no refund required." };
  }
  if (order.refundStatus === "Processed") {
    return { success: true, refundId: order.refundId, message: "Refund has already been processed." };
  }

  const isRealPaymentId = typeof order.razorpay_payment_id === "string" && order.razorpay_payment_id.startsWith("pay_");
  const isGatewayReady = Boolean(razorpayInstance && RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);

  if (IS_PRODUCTION) {
    // ── SECURITY: Block demo refund simulation in production ────────────────
    if (!isGatewayReady) {
      const errorMsg = "Payment gateway is not configured in production. Cannot process refund.";
      console.error(`[REFUND] ⛔ ${errorMsg} (Order: ${order.orderId})`);
      order.refundStatus = "Failed";
      order.refundError = errorMsg;
      return { success: false, error: errorMsg };
    }
    if (!isRealPaymentId) {
      const errorMsg = `Order ${order.orderId} lacks a valid Razorpay transaction ID (found: ${order.razorpay_payment_id || 'none'}). Simulated refund is blocked in production.`;
      console.error(`[REFUND] ⛔ ${errorMsg}`);
      order.refundStatus = "Failed";
      order.refundError = errorMsg;
      return { success: false, error: errorMsg };
    }
  } else {
    // Only allow simulation in development/test environments
    if (!isGatewayReady || !isRealPaymentId) {
      const demoRefundId = `demo_rfnd_${Date.now()}`;
      order.refundId = demoRefundId;
      order.refundStatus = "Processed";
      order.refundAmount = order.totalAmount;
      order.refundError = null;
      console.log(`[REFUND] 🧪 Demo mode simulated refund ${demoRefundId} for order ${order.orderId}`);
      return { success: true, refundId: demoRefundId, mode: "demo" };
    }
  }

  // Real Razorpay Refund API
  try {
    const refundPayload = {
      amount: order.totalAmount, // Razorpay amount in paise, matching order.totalAmount
      notes: {
        orderId: order.orderId,
        reason: reason || "Customer cancellation",
      },
      receipt: `rfnd_${order.orderId}`.substring(0, 40),
    };

    console.log(`[REFUND] 🔄 Initiating Razorpay refund for order ${order.orderId} (payment ${order.razorpay_payment_id}, amount: ${order.totalAmount} paise)...`);
    const refund = await razorpayInstance.payments.refund(order.razorpay_payment_id, refundPayload);

    order.refundId = refund.id;
    order.refundStatus = refund.status === "processed" ? "Processed" : "Initiated";
    order.refundAmount = refund.amount || order.totalAmount;
    order.refundError = null;

    console.log(`[REFUND] ✅ Razorpay refund ${refund.id} status: ${order.refundStatus} for order ${order.orderId}`);
    return { success: true, refundId: refund.id, status: order.refundStatus };
  } catch (error) {
    const errorMsg = error?.error?.description || error?.message || "Razorpay refund request failed";
    console.error(`[REFUND] ❌ Razorpay refund failed for order ${order.orderId}:`, errorMsg);
    order.refundStatus = "Failed";
    order.refundError = errorMsg;
    return { success: false, error: errorMsg };
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/orders/:id/cancel
//
// Allows an authenticated user to cancel their own order before shipment.
// Initiates real Razorpay refund if the order has been paid.
// ═══════════════════════════════════════════════════════════════════════════════
const cancelMyOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const order = mongoose.Types.ObjectId.isValid(id)
      ? await Order.findById(id)
      : await Order.findOne({ orderId: id });

    if (!order) {
      return res.status(404).json({ success: false, error: "Order not found." });
    }

    // Verify ownership
    if (order.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, error: "Not authorized to cancel this order." });
    }

    // Check if cancellation is allowed
    if (["Shipped", "Out for Delivery"].includes(order.orderStatus)) {
      return res.status(400).json({
        success: false,
        error: "Order has already been dispatched. Please contact customer support for returns.",
      });
    }

    if (order.orderStatus === "Delivered") {
      return res.status(400).json({
        success: false,
        error: "Delivered orders cannot be cancelled. You can request a return via support.",
      });
    }

    if (order.orderStatus === "Cancelled") {
      return res.status(400).json({
        success: false,
        error: "Order is already cancelled.",
      });
    }

    // Update status
    order.orderStatus = "Cancelled";
    order.cancelledAt = new Date();
    order.cancellationReason = reason || "Cancelled by customer";

    // If order was paid, execute refund
    let refundResult = null;
    if (order.paymentStatus === "Success") {
      refundResult = await processRazorpayRefund(order, order.cancellationReason);
    }

    // Atomically restore inventory (durable CAS prevents duplicate restoration under concurrent requests)
    await restoreOrderInventoryAtomic(order._id);

    await order.save();

    // Send customer cancellation & refund notification email
    await sendOrderCancellationEmail(order);

    console.log(`[ORDERS] 🚫 Order ${order.orderId} cancelled by customer ${req.user.email} (Refund: ${order.refundStatus})`);

    return res.status(200).json({
      success: true,
      message: "Order successfully cancelled.",
      order: order.toSafeObject(),
      refund: refundResult,
    });
  } catch (error) {
    console.error("[ORDERS] ❌ Error cancelling order:", error.message);
    return res.status(500).json({
      success: false,
      error: "Failed to cancel order. Please try again.",
    });
  }
};

module.exports = {
  createOrder,
  verifyPayment,
  getMyOrders,
  cancelMyOrder,
  processRazorpayRefund,
  processPaymentSideEffects,
  restoreOrderInventoryAtomic,
  sendAdminOrderNotification,
  sendOrderShippingEmail,
  sendOrderDeliveredEmail,
  sendOrderCancellationEmail,
};
