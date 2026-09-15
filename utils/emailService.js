// ─────────────────────────────────────────────────────────────────────────────
// utils/emailService.js
//
// AMBIENCE — Email Service via Gmail REST API (googleapis)
//
// WHY GMAIL API INSTEAD OF SMTP?
//   Render blocks ALL outbound SMTP ports (465, 587) → ETIMEDOUT.
//   Resend/SendGrid/etc. require a custom verified domain to send to
//   arbitrary recipients.
//
//   Gmail REST API uses HTTPS (port 443) — never blocked — and sends
//   FROM your own Gmail account. No custom domain needed.
//
// Features:
//   • Uses Gmail API v1 over HTTPS — works on Render, Railway, Vercel, etc.
//   • Sends from your existing Gmail account (ambienceai@gmail.com)
//   • Adds plain-text fallback for every email (spam-filter friendly)
//   • Full error diagnostics on failure
//   • Startup verification of credentials
//
// Required .env variables:
//   GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
//   GOOGLE_CLIENT_SECRET=GOCSPX-xxxxx
//   GMAIL_REFRESH_TOKEN=1//xxxxx   (one-time generation via OAuth Playground)
//   GMAIL_USER=your-email@gmail.com
//
// How to get GMAIL_REFRESH_TOKEN (one-time setup):
//   1. Go to https://developers.google.com/oauthplayground
//   2. Click ⚙️ (gear icon) → Check "Use your own OAuth credentials"
//   3. Enter your GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
//   4. In Step 1, find "Gmail API v1" → select:
//        https://www.googleapis.com/auth/gmail.send
//   5. Click "Authorize APIs" → sign in with your GMAIL_USER account
//   6. Click "Exchange authorization code for tokens"
//   7. Copy the "Refresh token" value → add as GMAIL_REFRESH_TOKEN in Render
// ─────────────────────────────────────────────────────────────────────────────

const { google } = require("googleapis");

// ── Read credentials from environment ────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const GMAIL_USER = process.env.GMAIL_USER;

// ── Detect whether real credentials have been provided ───────────────────────
const isConfigured =
  GOOGLE_CLIENT_ID &&
  GOOGLE_CLIENT_SECRET &&
  GMAIL_REFRESH_TOKEN &&
  GMAIL_USER &&
  !GMAIL_USER.includes("your-");

let oauth2Client = null;
let gmail = null;

if (isConfigured) {
  oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );

  oauth2Client.setCredentials({
    refresh_token: GMAIL_REFRESH_TOKEN,
  });

  gmail = google.gmail({ version: "v1", auth: oauth2Client });

  // ── Startup verification ───────────────────────────────────────────────────
  // Test the credentials by fetching the user's profile
  gmail.users
    .getProfile({ userId: "me" })
    .then((res) => {
      console.log("");
      console.log("┌──────────────────────────────────────────────────────────┐");
      console.log("│  ✅  Gmail API verified — email delivery is ACTIVE      │");
      console.log(`│  Account: ${(res.data.emailAddress || GMAIL_USER).padEnd(45)}│`);
      console.log("│  Transport: Gmail REST API (HTTPS, port 443)            │");
      console.log("└──────────────────────────────────────────────────────────┘");
      console.log("");
    })
    .catch((err) => {
      console.error("");
      console.error("╔══════════════════════════════════════════════════════════╗");
      console.error("║  ❌  Gmail API verification FAILED at startup           ║");
      console.error("╚══════════════════════════════════════════════════════════╝");
      console.error("");
      console.error("  Error Details:");
      console.error(`    message : ${err.message}`);
      console.error(`    code    : ${err.code || "N/A"}`);
      console.error(`    status  : ${err.status || "N/A"}`);
      console.error("");
      console.error("  Troubleshooting:");
      console.error("    1. Enable Gmail API in Google Cloud Console:");
      console.error("       → https://console.cloud.google.com/apis/library/gmail.googleapis.com");
      console.error("    2. Verify GMAIL_REFRESH_TOKEN was generated correctly");
      console.error("       → https://developers.google.com/oauthplayground");
      console.error("    3. Ensure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are correct");
      console.error("    4. Sign in with the same account as GMAIL_USER when generating token");
      console.error("");
    });
} else {
  const isProduction = process.env.NODE_ENV === "production";
  console.log("");
  if (isProduction) {
    console.error("╔══════════════════════════════════════════════════════════╗");
    console.error("║  🚨  PRODUCTION: Gmail API credentials MISSING!         ║");
    console.error("║  Emails WILL FAIL. Set GMAIL_REFRESH_TOKEN in Render    ║");
    console.error("║  Environment Variables immediately.                     ║");
    console.error("╚══════════════════════════════════════════════════════════╝");
  } else {
    console.log("┌──────────────────────────────────────────────────────────┐");
    console.log("│  ⚠️  Gmail API credentials not configured — DEV MODE    │");
    console.log("│  OTP codes will be logged to the console only.          │");
    console.log("│  Set GMAIL_REFRESH_TOKEN in .env to enable.             │");
    console.log("└──────────────────────────────────────────────────────────┘");
  }
  console.log("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: Build a RFC 2822 MIME email and base64url-encode it
// ─────────────────────────────────────────────────────────────────────────────
function buildRawEmail({ from, to, subject, html, text }) {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const plainText = text || stripHtml(html);

  const messageParts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    `X-Mailer: Ambience/1.0`,
    `Reply-To: ${GMAIL_USER}`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(plainText, "utf-8").toString("base64"),
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    Buffer.from(html, "utf-8").toString("base64"),
    ``,
    `--${boundary}--`,
  ];

  const rawMessage = messageParts.join("\r\n");

  // Gmail API requires base64url encoding (no +, /, or = padding)
  return Buffer.from(rawMessage, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

const isEmailConfigured = () => isConfigured;

/**
 * Send an email via Gmail REST API.
 *
 * In DEV MODE (no credentials), logs to console and returns null.
 * In PROD MODE, sends via Gmail API and throws on failure so the
 * caller can return a proper 500 to the frontend.
 *
 * @param {Object}  opts
 * @param {string}  opts.to       — Recipient email address
 * @param {string}  opts.subject  — Email subject line
 * @param {string}  opts.html     — HTML body
 * @param {string}  [opts.text]   — Optional plain-text fallback
 * @param {string}  [opts.logLabel="Email"] — Label for console logs
 * @returns {Promise<Object|null>} Gmail API response, or null in dev mode
 */
const sendEmail = async ({ to, subject, html, text, logLabel = "Email" }) => {
  // ── GUARD: Validate recipient before doing anything ────────────────────────
  if (!to || typeof to !== "string" || !to.includes("@")) {
    const msg = `[AMBIENCE] ❌ ${logLabel} BLOCKED — invalid recipient: "${to}"`;
    console.error(msg);
    throw new Error("Invalid recipient email address.");
  }

  // ── PROD MODE — real email delivery via Gmail API ──────────────────────────
  if (isEmailConfigured() && gmail) {
    try {
      const raw = buildRawEmail({
        from: `"Ambience" <${GMAIL_USER}>`,
        to,
        subject,
        html,
        text,
      });

      const result = await gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw,
        },
      });

      console.log(
        `[AMBIENCE] ✉️  ${logLabel} sent successfully` +
          ` | To: ${to}` +
          ` | MessageID: ${result.data.id}`
      );
      return result.data;
    } catch (error) {
      // ── Full error diagnostics ─────────────────────────────────────────
      console.error("");
      console.error(`[AMBIENCE] ❌ ${logLabel} SEND FAILED`);
      console.error("─".repeat(60));
      console.error(`  To           : ${to}`);
      console.error(`  Subject      : ${subject}`);
      console.error(`  Error Message: ${error.message}`);
      console.error(`  Error Code   : ${error.code || "N/A"}`);
      console.error(`  Status       : ${error.status || "N/A"}`);
      if (error.errors) {
        console.error(`  API Errors   : ${JSON.stringify(error.errors)}`);
      }
      console.error("─".repeat(60));
      console.error("");

      // Re-throw so the controller can return 500 to the frontend
      throw error;
    }
  }

  // ── NO CREDENTIALS — Production vs Dev handling ────────────────────────────
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction) {
    const msg =
      "[AMBIENCE] 🚨 PRODUCTION EMAIL FAILURE — GMAIL_REFRESH_TOKEN " +
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
  console.log("│  (Set GMAIL_REFRESH_TOKEN in .env for real delivery)   │");
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
