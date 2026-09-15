// ─────────────────────────────────────────────────────────────────────────────
// utils/emailService.js
//
// AMBIENCE — Email Service via Resend (HTTP API)
//
// WHY RESEND INSTEAD OF NODEMAILER/SMTP?
//   Render's free tier blocks ALL outbound SMTP ports (465 and 587), causing
//   ETIMEDOUT errors with Gmail SMTP. Resend uses HTTPS (port 443) which is
//   never blocked by any PaaS provider.
//
// Features:
//   • Uses Resend HTTP API — works on Render, Railway, Vercel, etc.
//   • Adds plain-text fallback for every email (spam-filter friendly)
//   • Full error diagnostics on failure
//   • Startup verification of API key
//
// Required .env variables:
//   RESEND_API_KEY=re_xxxxxxxxxxxx   (from https://resend.com/api-keys)
//   GMAIL_USER=your-email@gmail.com  (used as reply-to address)
//
// Optional .env:
//   RESEND_FROM=Ambience <noreply@yourdomain.com>  (requires verified domain)
//   If not set, uses Resend's default onboarding address.
// ─────────────────────────────────────────────────────────────────────────────

const { Resend } = require("resend");

// ── Read credentials from environment ────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const GMAIL_USER = process.env.GMAIL_USER; // used as reply-to
const RESEND_FROM =
  process.env.RESEND_FROM || "Ambience <onboarding@resend.dev>";

// ── Detect whether real credentials have been provided ───────────────────────
const isConfigured =
  RESEND_API_KEY &&
  RESEND_API_KEY.startsWith("re_") &&
  RESEND_API_KEY.length > 10;

let resend = null;

if (isConfigured) {
  resend = new Resend(RESEND_API_KEY);

  // ── Startup verification ───────────────────────────────────────────────────
  // Send a test API call to verify the key is valid at boot time.
  resend.apiKeys
    .list()
    .then(() => {
      console.log("");
      console.log("┌──────────────────────────────────────────────────────────┐");
      console.log("│  ✅  Resend API verified — email delivery is ACTIVE     │");
      console.log(`│  From: ${RESEND_FROM.padEnd(49)}│`);
      console.log(`│  Reply-To: ${(GMAIL_USER || "not set").padEnd(45)}│`);
      console.log("│  Transport: Resend HTTP API (port 443)                  │");
      console.log("└──────────────────────────────────────────────────────────┘");
      console.log("");
    })
    .catch((err) => {
      console.error("");
      console.error("╔══════════════════════════════════════════════════════════╗");
      console.error("║  ❌  Resend API verification FAILED at startup          ║");
      console.error("╚══════════════════════════════════════════════════════════╝");
      console.error("");
      console.error("  Error Details:");
      console.error(`    message : ${err.message}`);
      console.error(`    name    : ${err.name || "N/A"}`);
      console.error("");
      console.error("  Troubleshooting:");
      console.error("    1. Verify RESEND_API_KEY starts with 're_'");
      console.error("    2. Generate a key at: https://resend.com/api-keys");
      console.error("    3. Add RESEND_API_KEY to Render Environment Variables");
      console.error("");
    });
} else {
  const isProduction = process.env.NODE_ENV === "production";
  console.log("");
  if (isProduction) {
    console.error("╔══════════════════════════════════════════════════════════╗");
    console.error("║  🚨  PRODUCTION: Resend API key MISSING!                ║");
    console.error("║  Emails WILL FAIL. Set RESEND_API_KEY in Render         ║");
    console.error("║  Environment Variables immediately.                     ║");
    console.error("║                                                         ║");
    console.error("║  Get your key at: https://resend.com/api-keys           ║");
    console.error("╚══════════════════════════════════════════════════════════╝");
  } else {
    console.log("┌──────────────────────────────────────────────────────────┐");
    console.log("│  ⚠️  Resend API key not configured — DEV MODE           │");
    console.log("│  OTP codes will be logged to the console only.          │");
    console.log("│  Set RESEND_API_KEY in .env to enable email delivery.   │");
    console.log("└──────────────────────────────────────────────────────────┘");
  }
  console.log("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

const isEmailConfigured = () => isConfigured;

/**
 * Send an email via Resend HTTP API.
 *
 * In DEV MODE (no API key), logs to console and returns null.
 * In PROD MODE, sends via Resend and throws on failure so the
 * caller can return a proper 500 to the frontend.
 *
 * @param {Object}  opts
 * @param {string}  opts.to       — Recipient email address
 * @param {string}  opts.subject  — Email subject line
 * @param {string}  opts.html     — HTML body
 * @param {string}  [opts.text]   — Optional plain-text fallback
 * @param {string}  [opts.logLabel="Email"] — Label for console logs
 * @returns {Promise<Object|null>} Resend response object, or null in dev mode
 */
const sendEmail = async ({ to, subject, html, text, logLabel = "Email" }) => {
  // ── GUARD: Validate recipient before doing anything ────────────────────────
  if (!to || typeof to !== "string" || !to.includes("@")) {
    const msg = `[AMBIENCE] ❌ ${logLabel} BLOCKED — invalid recipient: "${to}"`;
    console.error(msg);
    throw new Error("Invalid recipient email address.");
  }

  // ── PROD MODE — real email delivery via Resend ─────────────────────────────
  if (isEmailConfigured() && resend) {
    try {
      const payload = {
        from: RESEND_FROM,
        to: [to],
        subject,
        html,
        // Plain-text fallback — critical for spam filters.
        // If the caller didn't provide one, auto-strip HTML tags.
        text: text || stripHtml(html),
      };

      // Add reply-to if GMAIL_USER is configured
      if (GMAIL_USER) {
        payload.reply_to = GMAIL_USER;
      }

      const { data, error } = await resend.emails.send(payload);

      if (error) {
        console.error("");
        console.error(`[AMBIENCE] ❌ ${logLabel} SEND FAILED (Resend API error)`);
        console.error("─".repeat(60));
        console.error(`  To           : ${to}`);
        console.error(`  Subject      : ${subject}`);
        console.error(`  Error Name   : ${error.name || "N/A"}`);
        console.error(`  Error Message: ${error.message || JSON.stringify(error)}`);
        console.error("─".repeat(60));
        console.error("");
        throw new Error(error.message || "Resend API error");
      }

      console.log(
        `[AMBIENCE] ✉️  ${logLabel} sent successfully` +
          ` | To: ${to}` +
          ` | ID: ${data?.id || "N/A"}`
      );
      return data;
    } catch (error) {
      // If it's already our formatted error from above, just re-throw
      if (error.message?.includes("Resend API error")) {
        throw error;
      }

      // ── Network / unexpected errors ────────────────────────────────────
      console.error("");
      console.error(`[AMBIENCE] ❌ ${logLabel} SEND FAILED`);
      console.error("─".repeat(60));
      console.error(`  To           : ${to}`);
      console.error(`  Subject      : ${subject}`);
      console.error(`  Error Message: ${error.message}`);
      console.error(`  Error Code   : ${error.code || "N/A"}`);
      console.error("─".repeat(60));
      console.error("");

      // Re-throw so the controller can return 500 to the frontend
      throw error;
    }
  }

  // ── NO CREDENTIALS — Production vs Dev handling ────────────────────────────
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction) {
    // In production, missing credentials is a FATAL configuration error.
    // Do NOT silently succeed — throw so the controller returns 500.
    const msg =
      "[AMBIENCE] 🚨 PRODUCTION EMAIL FAILURE — RESEND_API_KEY " +
      "is not set in Render Environment Variables. Email cannot be sent.";
    console.error(msg);
    throw new Error("Email service is not configured. Contact support.");
  }

  // ── DEV MODE — console logging only ────────────────────────────────────────
  console.log("");
  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log(`│  📧  AMBIENCE ${logLabel} — DEV MODE`.padEnd(58) + "│");
  console.log(`│  To:      ${to}`.padEnd(58) + "│");
  console.log(`│  Subject: ${subject}`.padEnd(58) + "│");
  console.log("│  (Set RESEND_API_KEY in .env for real email delivery)  │");
  console.log("└─────────────────────────────────────────────────────────┘");
  console.log("");
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility: Strip HTML tags to produce a plain-text fallback
// ─────────────────────────────────────────────────────────────────────────────
function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")   // remove <style> blocks
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")  // remove <script> blocks
    .replace(/<!--[\s\S]*?-->/g, "")                    // remove comments
    .replace(/<br\s*\/?>/gi, "\n")                      // <br> → newline
    .replace(/<\/p>/gi, "\n\n")                         // </p> → double newline
    .replace(/<\/tr>/gi, "\n")                          // </tr> → newline
    .replace(/<\/td>/gi, " ")                           // </td> → space
    .replace(/<[^>]+>/g, "")                            // strip remaining tags
    .replace(/&nbsp;/gi, " ")                           // decode &nbsp;
    .replace(/&amp;/gi, "&")                            // decode &amp;
    .replace(/&lt;/gi, "<")                             // decode &lt;
    .replace(/&gt;/gi, ">")                             // decode &gt;
    .replace(/&copy;/gi, "©")                           // decode &copy;
    .replace(/&mdash;/gi, "—")                          // decode &mdash;
    .replace(/&zwnj;/gi, "")                            // remove zero-width non-joiner
    .replace(/&#\d+;/g, "")                             // remove numeric HTML entities
    .replace(/\n{3,}/g, "\n\n")                         // collapse 3+ newlines → 2
    .replace(/[ \t]+/g, " ")                            // collapse whitespace
    .trim();
}

module.exports = {
  sendEmail,
  isEmailConfigured,
};
