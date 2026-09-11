// ─────────────────────────────────────────────────────────────────────────────
// smsService.js — AMBIENCE Real SMS Delivery via Twilio
//
// Sends actual SMS messages using Twilio's API.
// Falls back to console logging in DEV MODE when credentials are not set.
//
// Required .env variables:
//   TWILIO_ACCOUNT_SID   — Your Twilio Account SID
//   TWILIO_AUTH_TOKEN     — Your Twilio Auth Token
//   TWILIO_PHONE_NUMBER   — Your Twilio phone number (e.g., +1234567890)
// ─────────────────────────────────────────────────────────────────────────────

const TWILIO_SID    = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM   = process.env.TWILIO_PHONE_NUMBER;

const isConfigured =
  TWILIO_SID &&
  TWILIO_TOKEN &&
  TWILIO_FROM &&
  !TWILIO_SID.includes("YOUR_") &&
  !TWILIO_TOKEN.includes("YOUR_");

let twilioClient = null;

if (isConfigured) {
  try {
    const twilio = require("twilio");
    twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
    console.log("[smsService] ✅ Twilio SMS client initialized");
  } catch (err) {
    console.error("[smsService] ❌ Twilio initialization failed:", err.message);
  }
} else {
  console.log("[smsService] ⚠️ Twilio credentials not configured. Running in DEV MODE (console logging).");
  console.log("[smsService]    Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER for real SMS.");
}

const isSMSConfigured = () => isConfigured && twilioClient !== null;

/**
 * Send an SMS message.
 * @param {Object} opts
 * @param {string} opts.to      — Recipient phone number (E.164 format, e.g. +919876543210)
 * @param {string} opts.message — SMS body text
 * @param {string} opts.logLabel — Label for console logging
 * @returns {Object} Twilio message object or mock result
 */
const sendSMS = async ({ to, message, logLabel = "SMS" }) => {
  if (isSMSConfigured()) {
    try {
      const result = await twilioClient.messages.create({
        body: message,
        from: TWILIO_FROM,
        to: to,
      });
      console.log(`[AMBIENCE] 📱 ${logLabel} sent to ${to} | SID: ${result.sid}`);
      return { success: true, messageId: result.sid };
    } catch (error) {
      console.error(`[AMBIENCE] ❌ ${logLabel} send failed:`, error.message);
      throw error; // Let the caller handle it and return proper HTTP error
    }
  } else {
    // DEV MODE — log to console instead of sending real SMS
    console.log("");
    console.log("┌─────────────────────────────────────────────────┐");
    console.log(`│  📱  AMBIENCE ${logLabel} — DEV MODE`.padEnd(50) + "│");
    console.log(`│  To:  ${to}`.padEnd(50) + "│");
    console.log(`│  Msg: ${message}`.padEnd(50) + "│");
    console.log("│  (Set TWILIO_* env vars for real SMS delivery)  │");
    console.log("└─────────────────────────────────────────────────┘");
    console.log("");
    return { success: true, messageId: "dev-" + Date.now() };
  }
};

module.exports = { sendSMS, isSMSConfigured };
