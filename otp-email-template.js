// ─────────────────────────────────────────────────────────────────────────────
// otp-email-template.js
//
// AMBIENCE — Luxury Dark-Themed OTP Email Template
//
// Premium HTML email for delivering 6-digit OTP codes with a dark,
// sophisticated aesthetic. Features neon-blue accents, glass-morphism
// containers, and gradient borders.
//
// Theme: Dark (#0a0a0a) with neon blue (#00f3ff) accents
// Layout: Table-based for maximum email client compatibility
// Tested: Gmail, Outlook, Apple Mail, Yahoo
//
// Uses inline CSS only — no external stylesheets.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates the premium dark-themed HTML email body for OTP delivery.
 *
 * @param {Object}  options
 * @param {string}  options.otp       — The 6-digit OTP code
 * @param {string}  options.email     — Recipient email address
 * @param {number}  [options.expiry]  — OTP expiry in minutes (default: 10)
 * @param {string}  [options.logoUrl] — Full URL or CID for the AMBIENCE logo image
 * @returns {string} Complete HTML email string
 */
const generateOTPEmail = ({ otp, email, expiry = 10, logoUrl }) => {
  // Split OTP into individual digits for glass-container rendering
  const otpDigits = otp.toString().split("");
  const digitCells = otpDigits
    .map(
      (digit) => `
        <td align="center" valign="middle" style="
          width: 48px;
          height: 60px;
          background-color: rgba(255, 255, 255, 0.04);
          border: 1px solid rgba(0, 243, 255, 0.2);
          border-radius: 8px;
          font-family: ui-monospace, SFMono-Regular, 'Cascadia Code', Menlo, Monaco, Consolas, 'Courier New', monospace;
          font-size: 32px;
          font-weight: 700;
          color: #00f3ff;
          letter-spacing: 0;
          padding: 0;
        ">${digit}</td>
      `
    )
    .join(`<td style="width: 8px;"></td>`);

  // Logo block — circular container with gradient border
  // Uses cid:ambience-logo if available, otherwise renders styled "A" letter
  const logoBlock = logoUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
        <tr>
          <td align="center" style="
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: linear-gradient(135deg, #00f3ff, #0080ff, #00f3ff);
            padding: 3px;
          ">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="
                  width: 74px;
                  height: 74px;
                  border-radius: 50%;
                  background-color: #0a0a0a;
                  text-align: center;
                  vertical-align: middle;
                ">
                  <img
                    src="${logoUrl}"
                    alt="AMBIENCE"
                    width="54"
                    height="54"
                    style="
                      display: block;
                      margin: 10px auto;
                      width: 54px;
                      height: 54px;
                      border-radius: 50%;
                      object-fit: cover;
                    "
                  />
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
        <tr>
          <td align="center" style="
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: linear-gradient(135deg, #00f3ff, #0080ff, #00f3ff);
            padding: 3px;
          ">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="
                  width: 74px;
                  height: 74px;
                  border-radius: 50%;
                  background-color: #0a0a0a;
                  text-align: center;
                  vertical-align: middle;
                  font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
                  font-size: 32px;
                  font-weight: 700;
                  color: #00f3ff;
                  letter-spacing: 2px;
                ">A</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>`;

  return `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Your Verification Code</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; background-color: #0a0a0a; }
    @media only screen and (max-width: 600px) {
      .email-container { width: 100% !important; padding: 16px !important; border-radius: 0 !important; }
      .otp-digit { width: 36px !important; height: 48px !important; font-size: 24px !important; }
    }
  </style>
</head>
<body style="
  margin: 0;
  padding: 0;
  background-color: #0a0a0a;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
">

  <!-- Preheader Text (hidden preview in inbox) -->
  <div style="display: none; max-height: 0; overflow: hidden; font-size: 1px; line-height: 1px; color: #0a0a0a;">
    Your AMBIENCE verification code is ${otp}. Valid for ${expiry} minutes. Do not share this code.
    &nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>

  <!-- Outer Wrapper — Dark gradient background -->
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #0a0a0a;">
    <tr>
      <td align="center" style="padding: 48px 16px;">

        <!-- Email Container -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" class="email-container" style="
          max-width: 520px;
          width: 100%;
          background-color: #111111;
          border-radius: 16px;
          overflow: hidden;
          border: 1px solid rgba(0, 243, 255, 0.1);
        ">

          <!-- Top Gradient Accent Line -->
          <tr>
            <td style="height: 3px; background: linear-gradient(90deg, #00f3ff, #0080ff, #00f3ff);"></td>
          </tr>

          <!-- Logo Section -->
          <tr>
            <td align="center" style="padding: 40px 40px 24px;">
              ${logoBlock}
            </td>
          </tr>

          <!-- Brand Name -->
          <tr>
            <td align="center" style="padding: 0 40px 8px;">
              <p style="
                margin: 0;
                font-size: 13px;
                font-weight: 600;
                color: #00f3ff;
                text-transform: uppercase;
                letter-spacing: 4px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
              ">AMBIENCE</p>
            </td>
          </tr>

          <!-- Header -->
          <tr>
            <td align="center" style="padding: 0 40px;">
              <h1 style="
                margin: 0 0 12px;
                font-size: 26px;
                font-weight: 300;
                color: #ffffff;
                letter-spacing: 1px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
              ">Verification Code</h1>

              <p style="
                margin: 0 0 32px;
                font-size: 14px;
                line-height: 1.6;
                color: #888888;
                letter-spacing: 0.3px;
              ">
                Enter the code below to verify your identity.<br />
                This code is valid for <span style="color: #00f3ff; font-weight: 600;">${expiry} minutes</span>.
              </p>
            </td>
          </tr>

          <!-- OTP Code — Glass Containers -->
          <tr>
            <td align="center" style="padding: 0 40px 36px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="
                background-color: rgba(0, 0, 0, 0.3);
                border: 1px solid rgba(0, 243, 255, 0.08);
                border-radius: 12px;
                padding: 20px 24px;
              ">
                <tr>
                  ${digitCells}
                </tr>
              </table>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td align="center" style="padding: 0 48px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="height: 1px; background: linear-gradient(90deg, transparent, rgba(0, 243, 255, 0.15), transparent);"></td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Security Warnings -->
          <tr>
            <td style="padding: 28px 40px 12px;">
              <!-- Warning 1: Do not share -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td width="28" valign="top" style="
                    font-size: 16px;
                    padding-top: 1px;
                  ">&#128274;</td>
                  <td style="
                    font-size: 13px;
                    line-height: 1.5;
                    color: #999999;
                    padding-bottom: 10px;
                    letter-spacing: 0.2px;
                  ">Do not share this code with anyone</td>
                </tr>
              </table>

              <!-- Warning 2: Expiry -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td width="28" valign="top" style="
                    font-size: 16px;
                    padding-top: 1px;
                  ">&#9201;</td>
                  <td style="
                    font-size: 13px;
                    line-height: 1.5;
                    color: #999999;
                    padding-bottom: 10px;
                    letter-spacing: 0.2px;
                  ">This code expires in <span style="color: #cccccc; font-weight: 600;">${expiry} minutes</span></td>
                </tr>
              </table>

              <!-- Warning 3: Didn't request -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td width="28" valign="top" style="
                    font-size: 16px;
                    padding-top: 1px;
                  ">&#9888;</td>
                  <td style="
                    font-size: 13px;
                    line-height: 1.5;
                    color: #999999;
                    padding-bottom: 4px;
                    letter-spacing: 0.2px;
                  ">If you didn't request this, please ignore this email</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Bottom Spacer -->
          <tr>
            <td style="height: 20px;"></td>
          </tr>

          <!-- Footer Divider -->
          <tr>
            <td align="center" style="padding: 0 48px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="height: 1px; background-color: rgba(255, 255, 255, 0.06);"></td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding: 24px 40px 32px;">
              <p style="
                margin: 0 0 6px;
                font-size: 11px;
                color: #444444;
                letter-spacing: 2px;
                text-transform: uppercase;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
              ">
                &copy; ${new Date().getFullYear()} AMBIENCE &mdash; Premium Digital Commerce
              </p>
              <p style="
                margin: 0;
                font-size: 11px;
                color: #333333;
                letter-spacing: 0.3px;
              ">
                This is an automated message. Please do not reply.
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
};

module.exports = { generateOTPEmail };
