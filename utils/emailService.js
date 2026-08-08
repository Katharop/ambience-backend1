const nodemailer = require("nodemailer");

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

const isConfigured =
  GMAIL_USER &&
  GMAIL_APP_PASSWORD &&
  !GMAIL_USER.includes("your-") &&
  !GMAIL_APP_PASSWORD.includes("xxxx");

let transporter = null;

if (isConfigured) {
  transporter = nodemailer.createTransport({
    service: "gmail",
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
  });

  transporter
    .verify()
    .then(() => console.log("[emailService] ✅ Gmail SMTP connection verified"))
    .catch((err) => {
      console.error("[emailService] ❌ Gmail SMTP verification failed:", err.message);
    });
} else {
  console.log("[emailService] ⚠️ Gmail credentials not configured correctly. Running in DEV MODE (console logging).");
}

const isEmailConfigured = () => isConfigured;

const sendEmail = async ({ to, subject, html, logLabel = "Email" }) => {
  if (isEmailConfigured() && transporter) {
    try {
      const info = await transporter.sendMail({
        from: `"Ambience" <${GMAIL_USER}>`,
        to,
        subject,
        html,
      });
      console.log(`[AMBIENCE] ✉️  ${logLabel} sent to ${to} | ID: ${info.messageId}`);
      return info;
    } catch (error) {
      console.error(`[AMBIENCE] ❌ ${logLabel} send failed:`, error.message);
      throw error;
    }
  } else {
    console.log("");
    console.log("┌─────────────────────────────────────────────────┐");
    console.log(`│  📧  AMBIENCE ${logLabel} — DEV MODE`.padEnd(50) + "│");
    console.log(`│  To:  ${to}`.padEnd(50) + "│");
    console.log("│  (Set GMAIL_USER/GMAIL_APP_PASSWORD for real delivery) │");
    console.log("└─────────────────────────────────────────────────┘");
    console.log("");
    return null;
  }
};

module.exports = {
  sendEmail,
  isEmailConfigured,
};
