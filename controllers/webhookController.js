// ─────────────────────────────────────────────────────────────────────────────
// controllers/webhookController.js
//
// AMBIENCE — Razorpay Webhook Handler (Production-Grade)
//
// Receives webhook events from Razorpay and updates order status atomically.
// This is the AUTHORITATIVE payment confirmation path — it catches payments
// even when the user's browser closes, network drops, or frontend crashes.
//
// SECURITY:
//   • HMAC-SHA256 signature verification on raw body (not parsed JSON)
//   • Uses crypto.timingSafeEqual to prevent timing attacks
//   • Idempotent — safe to receive duplicate events
//   • Atomic MongoDB updates with conditions (no race conditions)
//   • Returns 200 OK for duplicates (Razorpay retries on non-2xx)
//   • No authentication middleware — secured by signature verification
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");
const Order = require("../models/Order");

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/payment/webhook
//
// Razorpay sends webhook events to this endpoint.
// The request body is raw (Buffer) — NOT parsed by express.json().
// ═══════════════════════════════════════════════════════════════════════════════
const handleWebhook = async (req, res) => {
  const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

  // ── Guard: Webhook secret must be configured ────────────────────────────
  if (!WEBHOOK_SECRET) {
    console.error("[WEBHOOK] CRITICAL: RAZORPAY_WEBHOOK_SECRET is not configured");
    return res.status(500).json({ status: "error", message: "Webhook not configured" });
  }

  // ── Step 1: Verify HMAC-SHA256 Signature ────────────────────────────────
  const receivedSignature = req.headers["x-razorpay-signature"];

  if (!receivedSignature) {
    console.warn(`[WEBHOOK] ⛔ Missing X-Razorpay-Signature header — IP: ${req.ip}`);
    return res.status(400).json({ status: "error", message: "Missing signature" });
  }

  // req.body is a raw Buffer (set up via express.raw in server.js)
  const rawBody = req.body;
  if (!rawBody || rawBody.length === 0) {
    console.warn(`[WEBHOOK] ⛔ Empty request body — IP: ${req.ip}`);
    return res.status(400).json({ status: "error", message: "Empty body" });
  }

  const expectedSignature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  let isValid = false;
  try {
    isValid = crypto.timingSafeEqual(
      Buffer.from(expectedSignature, "hex"),
      Buffer.from(receivedSignature, "hex")
    );
  } catch (err) {
    // Buffer length mismatch → signature is invalid
    console.warn(`[WEBHOOK] ⛔ Signature length mismatch — IP: ${req.ip}`);
    return res.status(400).json({ status: "error", message: "Invalid signature" });
  }

  if (!isValid) {
    console.warn(
      `[WEBHOOK] ⛔ Signature verification FAILED — IP: ${req.ip} | ` +
      `Received: ${receivedSignature.substring(0, 16)}...`
    );
    return res.status(400).json({ status: "error", message: "Signature verification failed" });
  }

  // ── Step 2: Parse the verified payload ──────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (parseErr) {
    console.error(`[WEBHOOK] ❌ Failed to parse webhook payload: ${parseErr.message}`);
    return res.status(400).json({ status: "error", message: "Invalid JSON" });
  }

  const event = payload.event;
  const payloadData = payload.payload;

  console.log(
    `[WEBHOOK] 📩 Received event: ${event} | ` +
    `Payment: ${payloadData?.payment?.entity?.id || "N/A"} | ` +
    `Order: ${payloadData?.payment?.entity?.order_id || payloadData?.order?.entity?.id || "N/A"}`
  );

  // ── Step 3: Route by event type ────────────────────────────────────────
  try {
    switch (event) {
      case "payment.captured":
      case "order.paid":
        await handlePaymentSuccess(event, payloadData);
        break;

      case "payment.failed":
        await handlePaymentFailure(event, payloadData);
        break;

      default:
        console.log(`[WEBHOOK] ℹ️ Unhandled event type: ${event} — acknowledged`);
    }
  } catch (err) {
    console.error(`[WEBHOOK] ❌ Error processing ${event}: ${err.message}`);
    // Still return 200 to prevent Razorpay from retrying on our processing errors
    // The error is logged and can be investigated manually
  }

  // Always return 200 to acknowledge receipt (Razorpay retries on non-2xx)
  return res.status(200).json({ status: "ok" });
};

// ═══════════════════════════════════════════════════════════════════════════════
// Handler: payment.captured / order.paid
//
// Atomically updates the order to "Success" ONLY if it's currently "Pending".
// This prevents duplicate processing if Razorpay sends the event multiple times.
// ═══════════════════════════════════════════════════════════════════════════════
const handlePaymentSuccess = async (event, payloadData) => {
  const payment = payloadData?.payment?.entity;
  if (!payment) {
    console.warn(`[WEBHOOK] ⚠️ ${event} — missing payment entity in payload`);
    return;
  }

  const razorpayOrderId = payment.order_id;
  const razorpayPaymentId = payment.id;
  const amountPaise = payment.amount;

  if (!razorpayOrderId) {
    console.warn(`[WEBHOOK] ⚠️ ${event} — missing order_id in payment entity`);
    return;
  }

  // Generate a hash of the payload for audit trail
  const payloadHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(payloadData))
    .digest("hex")
    .substring(0, 16);

  // Atomic update: only update if paymentStatus is "Pending" (idempotency guard)
  const updatedOrder = await Order.findOneAndUpdate(
    {
      razorpay_order_id: razorpayOrderId,
      paymentStatus: "Pending", // CRITICAL: Only update pending orders
    },
    {
      $set: {
        razorpay_payment_id: razorpayPaymentId,
        paymentStatus: "Success",
        orderStatus: "Confirmed",
        webhookVerified: true,
        paidAt: new Date(),
      },
      $push: {
        webhookEvents: {
          event,
          timestamp: new Date(),
          payloadHash,
        },
      },
    },
    { new: true }
  );

  if (updatedOrder) {
    console.log(
      `[WEBHOOK] ✅ Order PAID via webhook: ${updatedOrder.orderId} | ` +
      `Payment: ${razorpayPaymentId} | ` +
      `Amount: ₹${amountPaise / 100} | ` +
      `User: ${updatedOrder.userEmail}`
    );
  } else {
    // Order not found OR already processed (idempotent — this is OK)
    const existingOrder = await Order.findOne({ razorpay_order_id: razorpayOrderId });
    if (existingOrder && existingOrder.paymentStatus === "Success") {
      // Duplicate webhook — log and record the event
      console.log(
        `[WEBHOOK] ℹ️ Duplicate ${event} for already-paid order: ${existingOrder.orderId} | ` +
        `Payment: ${razorpayPaymentId} — skipping`
      );
      // Still record the duplicate event for audit
      await Order.updateOne(
        { _id: existingOrder._id },
        {
          $push: {
            webhookEvents: {
              event: `${event}:duplicate`,
              timestamp: new Date(),
              payloadHash,
            },
          },
        }
      );
    } else if (!existingOrder) {
      console.warn(
        `[WEBHOOK] ⚠️ Order NOT FOUND for razorpay_order_id: ${razorpayOrderId} | ` +
        `Payment: ${razorpayPaymentId}`
      );
    } else {
      console.warn(
        `[WEBHOOK] ⚠️ Order ${existingOrder.orderId} in unexpected state: ${existingOrder.paymentStatus} | ` +
        `Event: ${event}`
      );
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// Handler: payment.failed
//
// Marks the order as "Failed" — only if still "Pending".
// ═══════════════════════════════════════════════════════════════════════════════
const handlePaymentFailure = async (event, payloadData) => {
  const payment = payloadData?.payment?.entity;
  if (!payment) {
    console.warn(`[WEBHOOK] ⚠️ ${event} — missing payment entity in payload`);
    return;
  }

  const razorpayOrderId = payment.order_id;
  const razorpayPaymentId = payment.id;
  const errorCode = payment.error_code || "unknown";
  const errorDescription = payment.error_description || "Payment failed";

  if (!razorpayOrderId) {
    console.warn(`[WEBHOOK] ⚠️ ${event} — missing order_id in payment entity`);
    return;
  }

  const payloadHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(payloadData))
    .digest("hex")
    .substring(0, 16);

  const updatedOrder = await Order.findOneAndUpdate(
    {
      razorpay_order_id: razorpayOrderId,
      paymentStatus: "Pending",
    },
    {
      $set: {
        razorpay_payment_id: razorpayPaymentId,
        paymentStatus: "Failed",
      },
      $push: {
        webhookEvents: {
          event,
          timestamp: new Date(),
          payloadHash,
        },
      },
    },
    { new: true }
  );

  if (updatedOrder) {
    console.warn(
      `[WEBHOOK] ⛔ Payment FAILED via webhook: ${updatedOrder.orderId} | ` +
      `Payment: ${razorpayPaymentId} | ` +
      `Error: ${errorCode} — ${errorDescription} | ` +
      `User: ${updatedOrder.userEmail}`
    );
  } else {
    console.log(`[WEBHOOK] ℹ️ ${event} for already-processed order: ${razorpayOrderId} — skipping`);
  }
};

module.exports = { handleWebhook };
