// ─────────────────────────────────────────────────────────────────────────────
// testMail.js
//
// AMBIENCE — Standalone Gmail SMTP Diagnostic Script
//
// Usage:  node testMail.js
//
// This script bypasses the full server and directly tests the Nodemailer
// connection + email delivery. Run it to isolate whether the problem is:
//   1. Credentials / Authentication
//   2. Network / Firewall / Port blocking
//   3. Gmail rejecting the email content (spam)
//   4. Some other SMTP-level error
//
// It reads GMAIL_USER and GMAIL_APP_PASSWORD from your .env file.
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const nodemailer = require("nodemailer");

// ── Step 1: Environment Variable Audit ──────────────────────────────────────
console.log("");
console.log("═".repeat(60));
console.log("  AMBIENCE — Gmail SMTP Diagnostic Tool");
console.log("═".repeat(60));
console.log("");

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

console.log("STEP 1: Environment Variable Audit");
console.log("─".repeat(60));
console.log(`  GMAIL_USER           : ${GMAIL_USER || "❌ NOT SET"}`);
console.log(`  GMAIL_APP_PASSWORD   : ${GMAIL_APP_PASSWORD ? "✅ SET (" + GMAIL_APP_PASSWORD.length + " chars)" : "❌ NOT SET"}`);

if (GMAIL_APP_PASSWORD) {
  const hasSpaces = /\s/.test(GMAIL_APP_PASSWORD);
  const hasDashes = /-/.test(GMAIL_APP_PASSWORD);
  const isLowerAlpha = /^[a-z]+$/.test(GMAIL_APP_PASSWORD);
  console.log(`  Has spaces?          : ${hasSpaces ? "⚠️  YES — remove spaces!" : "✅ No"}`);
  console.log(`  Has dashes?          : ${hasDashes ? "⚠️  YES — remove dashes!" : "✅ No"}`);
  console.log(`  Is 16 lowercase chars: ${GMAIL_APP_PASSWORD.length === 16 && isLowerAlpha ? "✅ Yes — correct format" : "⚠️  Unexpected format (expected 16 lowercase letters)"}`);
}

if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error("\n❌ Missing credentials. Set GMAIL_USER and GMAIL_APP_PASSWORD in .env\n");
  process.exit(1);
}

console.log("");

// ── Step 2: Create Transporter with Full Debug Logging ──────────────────────
console.log("STEP 2: Creating SMTP Transporter");
console.log("─".repeat(60));
console.log("  Host   : smtp.gmail.com");
console.log("  Port   : 465");
console.log("  Secure : true (implicit TLS)");
console.log("  Auth   : PLAIN");
console.log("");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
  // Full SMTP handshake logging
  logger: true,
  debug: true,
  // Timeouts
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 30000,
  tls: {
    rejectUnauthorized: true,
  },
});

// ── Step 3: Verify SMTP Connection ──────────────────────────────────────────
async function runDiagnostic() {
  console.log("STEP 3: Verifying SMTP Connection (transporter.verify)");
  console.log("─".repeat(60));

  try {
    await transporter.verify();
    console.log("");
    console.log("  ✅ SMTP connection verified — authentication successful");
    console.log("");
  } catch (err) {
    console.error("");
    console.error("  ❌ SMTP verification FAILED");
    console.error(`     Message      : ${err.message}`);
    console.error(`     Code         : ${err.code || "N/A"}`);
    console.error(`     Command      : ${err.command || "N/A"}`);
    console.error(`     Response     : ${err.response || "N/A"}`);
    console.error(`     ResponseCode : ${err.responseCode || "N/A"}`);
    console.error("");
    console.error("  Possible fixes:");
    console.error("    1. Regenerate App Password at https://myaccount.google.com/apppasswords");
    console.error("    2. Ensure 2-Step Verification is enabled");
    console.error("    3. Check firewall is not blocking port 465");
    console.error("");
    transporter.close();
    process.exit(1);
  }

  // ── Step 4: Send a Real Test Email ────────────────────────────────────────
  console.log("STEP 4: Sending Test Email");
  console.log("─".repeat(60));
  console.log(`  From    : "Ambience" <${GMAIL_USER}>`);
  console.log(`  To      : ${GMAIL_USER}`);
  console.log(`  Subject : AMBIENCE OTP Test — ${new Date().toLocaleTimeString()}`);
  console.log("");

  const testOTP = Math.floor(1000 + Math.random() * 9000).toString();

  try {
    const info = await transporter.sendMail({
      from: `"Ambience" <${GMAIL_USER}>`,
      to: GMAIL_USER,
      replyTo: GMAIL_USER,
      subject: `Your AMBIENCE Verification Code — Test ${new Date().toLocaleTimeString()}`,
      text: [
        "AMBIENCE — Verification Code",
        "",
        `Your verification code is: ${testOTP}`,
        "",
        "This code is valid for 20 minutes.",
        "Do not share this code with anyone.",
        "",
        "If you did not request this, please ignore this email.",
        "",
        `© ${new Date().getFullYear()} AMBIENCE — Premium Digital Commerce`,
        "This is an automated message. Please do not reply.",
      ].join("\n"),
      html: `
        <!DOCTYPE html>
        <html lang="en">
        <head><meta charset="UTF-8" /><title>Your Verification Code</title></head>
        <body style="margin:0;padding:0;background-color:#0a0a0a;font-family:Arial,Helvetica,sans-serif;">
          <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#0a0a0a;">
            Your AMBIENCE verification code is ${testOTP}. Valid for 20 minutes.
          </div>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#0a0a0a;">
            <tr>
              <td align="center" style="padding:48px 16px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" style="max-width:520px;width:100%;background-color:#111111;border-radius:16px;overflow:hidden;border:1px solid rgba(0,243,255,0.1);">
                  <tr><td style="height:3px;background:linear-gradient(90deg,#00f3ff,#0080ff,#00f3ff);"></td></tr>
                  <tr>
                    <td align="center" style="padding:40px 40px 8px;">
                      <p style="margin:0;font-size:13px;font-weight:600;color:#00f3ff;text-transform:uppercase;letter-spacing:4px;">AMBIENCE</p>
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="padding:0 40px;">
                      <h1 style="margin:0 0 12px;font-size:26px;font-weight:300;color:#ffffff;letter-spacing:1px;">Verification Code</h1>
                      <p style="margin:0 0 32px;font-size:14px;line-height:1.6;color:#888888;">Enter the code below to verify your identity.</p>
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="padding:0 40px 36px;">
                      <div style="background-color:rgba(0,0,0,0.3);border:1px solid rgba(0,243,255,0.08);border-radius:12px;padding:20px 24px;display:inline-block;">
                        <span style="font-family:monospace;font-size:32px;font-weight:700;color:#00f3ff;letter-spacing:12px;">${testOTP}</span>
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="padding:24px 40px 32px;">
                      <p style="margin:0;font-size:13px;color:#999999;">Do not share this code with anyone.</p>
                      <p style="margin:8px 0 0;font-size:11px;color:#444444;">&copy; ${new Date().getFullYear()} AMBIENCE</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `.trim(),
      headers: {
        "X-Mailer": "Ambience/1.0",
      },
    });

    console.log("");
    console.log("═".repeat(60));
    console.log("  ✅  EMAIL SENT SUCCESSFULLY!");
    console.log("═".repeat(60));
    console.log(`  Message ID : ${info.messageId}`);
    console.log(`  Response   : ${info.response}`);
    console.log(`  Accepted   : ${JSON.stringify(info.accepted)}`);
    console.log(`  Rejected   : ${JSON.stringify(info.rejected)}`);
    console.log(`  Test OTP   : ${testOTP}`);
    console.log("");
    console.log("  → Check the inbox (and Spam folder) of:");
    console.log(`    ${GMAIL_USER}`);
    console.log("");
  } catch (err) {
    console.error("");
    console.error("═".repeat(60));
    console.error("  ❌  EMAIL SEND FAILED!");
    console.error("═".repeat(60));
    console.error(`  Message      : ${err.message}`);
    console.error(`  Code         : ${err.code || "N/A"}`);
    console.error(`  Command      : ${err.command || "N/A"}`);
    console.error(`  Response     : ${err.response || "N/A"}`);
    console.error(`  ResponseCode : ${err.responseCode || "N/A"}`);
    console.error("");
  }

  transporter.close();
}

runDiagnostic();
