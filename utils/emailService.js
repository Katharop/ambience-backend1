// ─────────────────────────────────────────────────────────────────────────────
// utils/emailService.js
//
// AMBIENCE — Gmail SMTP Email Service (Nodemailer)
//
// Hardened for deliverability:
//   • Uses `service: 'gmail'` (Port 587 + STARTTLS) — compatible with Render,
//     Railway, and other PaaS hosts that block outbound Port 465.
//   • Adds plain-text fallback for every email (spam-filter friendly)
//   • Logs full SMTP diagnostics on failure (code, command, response)
//   • Runs transporter.verify() at startup to surface auth issues immediately
//   • Adds anti-spam headers (Reply-To, List-Unsubscribe, X-Mailer)
//
// Required .env variables:
//   GMAIL_USER=your-real-email@gmail.com
//   GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx   (16-char App Password from Google)
// ─────────────────────────────────────────────────────────────────────────────

const nodemailer = require("nodemailer");

// ── Read credentials from environment ────────────────────────────────────────
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// ── Detect whether real credentials have been provided ───────────────────────
const isConfigured =
  GMAIL_USER &&
  GMAIL_APP_PASSWORD &&
  !GMAIL_USER.includes("your-") &&
  !GMAIL_APP_PASSWORD.includes("xxxx");

let transporter = null;
let transporterVerified = false; // tracks verify() result

if (isConfigured) {
  // ────────────────────────────────────────────────────────────────────────────
  // Gmail SMTP — Port 587 + STARTTLS (explicit)
  //
  // Render blocks outbound Port 465 (direct SMTPS → ETIMEDOUT).
  // `service: 'gmail'` also maps to port 465 internally, so it won't work.
  // Port 587 with secure:false triggers STARTTLS upgrade, which Render allows.
  // ────────────────────────────────────────────────────────────────────────────
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false, // false = use STARTTLS upgrade (NOT plain text)
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
    // Timeouts — surface failures fast instead of hanging
    connectionTimeout: 10000, // 10 s to establish TCP connection
    greetingTimeout: 10000,   // 10 s for SMTP greeting
    socketTimeout: 30000,     // 30 s for socket inactivity
    // TLS — relaxed for Render's proxy/NAT layer
    tls: {
      rejectUnauthorized: false,
    },
  });

  // ── Startup SMTP verification ──────────────────────────────────────────────
  // Immediately test the connection so auth/network problems are surfaced at
  // boot time, not when the first user hits "Send OTP".
  transporter
    .verify()
    .then(() => {
      transporterVerified = true;
      console.log("");
      console.log("┌──────────────────────────────────────────────────────────┐");
      console.log("│  ✅  Gmail SMTP verified — email delivery is ACTIVE     │");
      console.log(`│  Account: ${GMAIL_USER.padEnd(45)}│`);
      console.log("│  Transport: smtp.gmail.com:587 (STARTTLS)              │");
      console.log("└──────────────────────────────────────────────────────────┘");
      console.log("");
    })
    .catch((err) => {
      transporterVerified = false;
      console.error("");
      console.error("╔══════════════════════════════════════════════════════════╗");
      console.error("║  ❌  Gmail SMTP verification FAILED at startup          ║");
      console.error("╚══════════════════════════════════════════════════════════╝");
      console.error("");
      console.error("  SMTP Error Details:");
      console.error(`    message      : ${err.message}`);
      console.error(`    code         : ${err.code || "N/A"}`);
      console.error(`    command      : ${err.command || "N/A"}`);
      console.error(`    response     : ${err.response || "N/A"}`);
      console.error(`    responseCode : ${err.responseCode || "N/A"}`);
      console.error("");
      console.error("  Troubleshooting:");
      console.error("    1. Verify GMAIL_USER in .env is a real Gmail address");
      console.error("    2. Verify GMAIL_APP_PASSWORD is a 16-char App Password");
      console.error("       → Generate at: https://myaccount.google.com/apppasswords");
      console.error("    3. Ensure 2-Step Verification is enabled on the Google account");
      console.error("    4. Check firewall / antivirus is not blocking port 587");
      console.error("");
    });
} else {
  const isProduction = process.env.NODE_ENV === "production";
  console.log("");
  if (isProduction) {
    console.error("╔══════════════════════════════════════════════════════════╗");
    console.error("║  🚨  PRODUCTION: Gmail credentials MISSING!              ║");
    console.error("║  Emails WILL FAIL. Set GMAIL_USER + GMAIL_APP_PASSWORD   ║");
    console.error("║  in Render Environment Variables immediately.            ║");
    console.error("╚══════════════════════════════════════════════════════════╝");
  } else {
    console.log("┌──────────────────────────────────────────────────────────┐");
    console.log("│  ⚠️  Gmail credentials not configured — DEV MODE        │");
    console.log("│  OTP codes will be logged to the console only.          │");
    console.log("│  Set GMAIL_USER + GMAIL_APP_PASSWORD in .env to enable. │");
    console.log("└──────────────────────────────────────────────────────────┘");
  }
  console.log("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

const isEmailConfigured = () => isConfigured;

/**
 * Send an email via Gmail SMTP.
 *
 * In DEV MODE (no credentials), logs to console and returns null.
 * In PROD MODE, sends via Nodemailer and throws on failure so the
 * caller can return a proper 500 to the frontend.
 *
 * @param {Object}  opts
 * @param {string}  opts.to       — Recipient email address
 * @param {string}  opts.subject  — Email subject line
 * @param {string}  opts.html     — HTML body
 * @param {string}  [opts.text]   — Optional plain-text fallback
 * @param {string}  [opts.logLabel="Email"] — Label for console logs
 * @returns {Promise<Object|null>} Nodemailer info object, or null in dev mode
 */
const sendEmail = async ({ to, subject, html, text, logLabel = "Email" }) => {
  // ── GUARD: Validate recipient before doing anything ────────────────────────
  if (!to || typeof to !== "string" || !to.includes("@")) {
    const msg = `[AMBIENCE] ❌ ${logLabel} BLOCKED — invalid recipient: "${to}"`;
    console.error(msg);
    throw new Error("Invalid recipient email address.");
  }

  // ── PROD MODE — real SMTP delivery ─────────────────────────────────────────
  if (isEmailConfigured() && transporter) {
    try {
      const info = await transporter.sendMail({
        from: `"Ambience" <${GMAIL_USER}>`,
        to,
        replyTo: GMAIL_USER, // helps pass spam filters
        subject,
        html,
        // Plain-text fallback — critical for spam filters.
        // If the caller didn't provide one, auto-strip HTML tags.
        text: text || stripHtml(html),
        // ── Anti-spam / deliverability headers ─────────────────────────────
        headers: {
          "X-Mailer": "Ambience/1.0",
          Precedence: "bulk",
          "List-Unsubscribe": `<mailto:${GMAIL_USER}?subject=unsubscribe>`,
        },
      });

      console.log(
        `[AMBIENCE] ✉️  ${logLabel} sent successfully` +
          ` | To: ${to}` +
          ` | MessageID: ${info.messageId}` +
          ` | Response: ${info.response}`
      );
      return info;
    } catch (error) {
      // ── FULL SMTP error diagnostics — never swallow silently ────────────
      console.error("");
      console.error(`[AMBIENCE] ❌ ${logLabel} SEND FAILED`);
      console.error("─".repeat(60));
      console.error(`  To           : ${to}`);
      console.error(`  Subject      : ${subject}`);
      console.error(`  Error Message: ${error.message}`);
      console.error(`  Error Code   : ${error.code || "N/A"}`);
      console.error(`  SMTP Command : ${error.command || "N/A"}`);
      console.error(`  SMTP Response: ${error.response || "N/A"}`);
      console.error(`  Response Code: ${error.responseCode || "N/A"}`);
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
      "[AMBIENCE] 🚨 PRODUCTION EMAIL FAILURE — GMAIL_USER or GMAIL_APP_PASSWORD " +
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
  console.log("│  (Set GMAIL_USER / GMAIL_APP_PASSWORD for real delivery)│");
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
