// ─────────────────────────────────────────────────────────────────────────────
// welcome-email-template.js
//
// AMBIENCE — Premium Welcome Email Template
//
// Sent after successful email verification (OTP confirmed).
// Includes the Ambience logo, welcome message, and getting-started guide.
//
// Theme: Pitch-black (#0a0a0a) · Neon Blue (#00f3ff) accent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates the premium HTML welcome email.
 *
 * @param {Object}  options
 * @param {string}  options.email     — Recipient email address
 * @param {string}  options.name      — User's display name
 * @param {string}  [options.logoUrl] — Full URL to the AMBIENCE logo image
 * @returns {string} Complete HTML email string
 */
const generateWelcomeEmail = ({ email, name, logoUrl }) => {
  const displayName = name || email.split("@")[0];
  const year = new Date().getFullYear();

  const logoBlock = logoUrl
    ? `<img
        src="${logoUrl}"
        alt="AMBIENCE"
        width="180"
        height="40"
        style="
          display: block;
          margin: 0 auto;
          max-width: 180px;
          height: auto;
          filter: drop-shadow(0 0 12px rgba(0, 243, 255, 0.25));
        "
      />`
    : `<h2 style="
        margin: 0;
        font-family: 'Poppins', 'Inter', 'Segoe UI', sans-serif;
        font-size: 28px;
        font-weight: 700;
        letter-spacing: 10px;
        text-transform: uppercase;
        color: #00f3ff;
        text-shadow: 0 0 20px rgba(0, 243, 255, 0.35);
      ">AMBIENCE</h2>`;

  return `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <title>Welcome to AMBIENCE</title>

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
    body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; background-color: #000000; }
    @media only screen and (max-width: 600px) {
      .email-container { width: 100% !important; padding: 16px !important; }
    }
    :root { color-scheme: dark; supported-color-schemes: dark; }
    [data-ogsc] body { background-color: #000000 !important; }
  </style>
</head>

<body style="
  margin: 0;
  padding: 0;
  background-color: #000000;
  font-family: 'Inter', 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
">

  <!-- Preheader Text -->
  <div style="display: none; max-height: 0; overflow: hidden; font-size: 1px; line-height: 1px; color: #000000;">
    Welcome to AMBIENCE, ${displayName}! Your account is now active and ready.
    &nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #000000;">
    <tr>
      <td align="center" style="padding: 40px 16px;">

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" class="email-container" style="
          max-width: 520px;
          width: 100%;
          background-color: #0a0a0a;
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 24px;
          overflow: hidden;
          box-shadow: 0 40px 100px -20px rgba(0, 0, 0, 0.90), 0 0 80px -30px rgba(0, 243, 255, 0.06);
        ">

          <!-- TOP ACCENT LINE -->
          <tr>
            <td align="center" style="padding-top: 0;">
              <div style="
                width: 80px;
                height: 2px;
                background: linear-gradient(90deg, transparent, #00f3ff, transparent);
                margin: 0 auto;
                box-shadow: 0 0 20px rgba(0, 243, 255, 0.25);
              "></div>
            </td>
          </tr>

          <!-- BRAND LOGO -->
          <tr>
            <td align="center" style="padding: 44px 40px 0;">
              ${logoBlock}
            </td>
          </tr>

          <!-- DIAMOND DIVIDER -->
          <tr>
            <td align="center" style="padding: 24px 60px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);"></td>
                  <td width="20" align="center" style="padding: 0 12px;">
                    <div style="width: 6px; height: 6px; background-color: #00f3ff; transform: rotate(45deg); box-shadow: 0 0 10px rgba(0, 243, 255, 0.40);"></div>
                  </td>
                  <td style="height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);"></td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- WELCOME MESSAGE -->
          <tr>
            <td align="center" style="padding: 32px 40px 0;">
              <div style="
                width: 56px;
                height: 56px;
                margin: 0 auto 20px;
                background: rgba(0, 243, 255, 0.06);
                border: 1px solid rgba(0, 243, 255, 0.15);
                border-radius: 16px;
                line-height: 56px;
                text-align: center;
                font-size: 28px;
              ">✨</div>

              <h1 style="
                margin: 0 0 12px;
                font-family: 'Poppins', 'Inter', 'Segoe UI', sans-serif;
                font-size: 24px;
                font-weight: 600;
                letter-spacing: 4px;
                text-transform: uppercase;
                color: #ffffff;
              ">Welcome, ${displayName}</h1>

              <p style="
                margin: 0 0 8px;
                font-family: 'Inter', 'Segoe UI', sans-serif;
                font-size: 14px;
                font-weight: 400;
                line-height: 1.7;
                color: rgba(255, 255, 255, 0.55);
              ">
                Your AMBIENCE vault has been activated successfully.
                You now have access to our exclusive collection.
              </p>

              <p style="
                margin: 0;
                font-family: 'Inter', 'Segoe UI', sans-serif;
                font-size: 12px;
                font-weight: 400;
                line-height: 1.5;
                color: rgba(255, 255, 255, 0.30);
              ">
                Registered email: <strong style="color: rgba(255, 255, 255, 0.70);">${email}</strong>
              </p>
            </td>
          </tr>

          <!-- FEATURES -->
          <tr>
            <td align="center" style="padding: 36px 40px 0;">
              <div style="
                width: 100%;
                padding: 24px;
                background: rgba(0, 243, 255, 0.02);
                border: 1px solid rgba(0, 243, 255, 0.10);
                border-radius: 20px;
              ">
                <p style="
                  margin: 0 0 16px;
                  font-family: 'Inter', 'Segoe UI', sans-serif;
                  font-size: 9px;
                  font-weight: 500;
                  letter-spacing: 3px;
                  text-transform: uppercase;
                  color: rgba(0, 243, 255, 0.60);
                  text-align: center;
                ">What Awaits You</p>

                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr>
                    <td style="padding: 10px 0;">
                      <p style="margin: 0; font-family: 'Inter', 'Segoe UI', sans-serif; font-size: 13px; color: rgba(255,255,255,0.75); line-height: 1.6;">
                        🏷️ <strong style="color: #00f3ff;">Exclusive Collections</strong> — Curated luxury items
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 10px 0;">
                      <p style="margin: 0; font-family: 'Inter', 'Segoe UI', sans-serif; font-size: 13px; color: rgba(255,255,255,0.75); line-height: 1.6;">
                        🔔 <strong style="color: #00f3ff;">Priority Notifications</strong> — First access to drops & deals
                      </p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 10px 0;">
                      <p style="margin: 0; font-family: 'Inter', 'Segoe UI', sans-serif; font-size: 13px; color: rgba(255,255,255,0.75); line-height: 1.6;">
                        🛡️ <strong style="color: #00f3ff;">Secure Vault</strong> — Your orders & preferences, protected
                      </p>
                    </td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>

          <!-- BOTTOM DIVIDER -->
          <tr>
            <td align="center" style="padding: 32px 60px 0;">
              <div style="
                height: 1px;
                background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent);
              "></div>
            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td align="center" style="padding: 24px 40px 40px;">
              <p style="
                margin: 0 0 12px;
                font-family: 'Inter', 'Segoe UI', sans-serif;
                font-size: 11px;
                font-weight: 400;
                line-height: 1.6;
                color: rgba(255, 255, 255, 0.25);
              ">
                Need help?
                <a href="mailto:support@ambience.com" style="color: #00f3ff; text-decoration: none; border-bottom: 1px solid rgba(0, 243, 255, 0.20);">Contact Support</a>
                &nbsp;·&nbsp;
                <a href="mailto:feedback@ambience.com" style="color: #00f3ff; text-decoration: none; border-bottom: 1px solid rgba(0, 243, 255, 0.20);">Send Feedback</a>
              </p>

              <p style="
                margin: 0 0 8px;
                font-family: 'Inter', 'Segoe UI', sans-serif;
                font-size: 10px;
                font-weight: 400;
                letter-spacing: 0.5px;
                color: rgba(255, 255, 255, 0.15);
              ">
                This is an automated welcome email from AMBIENCE. Please do not reply directly.
              </p>

              <p style="
                margin: 0;
                font-family: 'Poppins', 'Inter', sans-serif;
                font-size: 10px;
                font-weight: 500;
                letter-spacing: 4px;
                text-transform: uppercase;
                color: rgba(255, 255, 255, 0.12);
              ">
                © ${year} AMBIENCE — All Rights Reserved
              </p>
            </td>
          </tr>

          <!-- BOTTOM ACCENT LINE -->
          <tr>
            <td align="center" style="padding-bottom: 0;">
              <div style="
                width: 50px;
                height: 1px;
                background: linear-gradient(90deg, transparent, rgba(0, 243, 255, 0.30), transparent);
                margin: 0 auto;
              "></div>
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

/**
 * Generates a premium HTML email for password reset confirmation.
 *
 * @param {Object}  options
 * @param {string}  options.email     — Recipient email address
 * @param {string}  [options.logoUrl] — Full URL to the AMBIENCE logo image
 * @returns {string} Complete HTML email string
 */
const generatePasswordResetConfirmEmail = ({ email, logoUrl }) => {
  const year = new Date().getFullYear();

  const logoBlock = logoUrl
    ? `<img src="${logoUrl}" alt="AMBIENCE" width="180" height="40" style="display: block; margin: 0 auto; max-width: 180px; height: auto; filter: drop-shadow(0 0 12px rgba(0, 243, 255, 0.25));" />`
    : `<h2 style="margin: 0; font-family: 'Poppins', 'Inter', 'Segoe UI', sans-serif; font-size: 28px; font-weight: 700; letter-spacing: 10px; text-transform: uppercase; color: #00f3ff; text-shadow: 0 0 20px rgba(0, 243, 255, 0.35);">AMBIENCE</h2>`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <title>Password Reset — AMBIENCE</title>
  <style>
    body { margin: 0; padding: 0; background-color: #000000; font-family: 'Inter', 'Segoe UI', sans-serif; }
    @media only screen and (max-width: 600px) { .email-container { width: 100% !important; padding: 16px !important; } }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #000000;">
  <div style="display: none; max-height: 0; overflow: hidden; font-size: 1px;">Your AMBIENCE password has been reset successfully.</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #000000;">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" class="email-container" style="max-width: 520px; width: 100%; background-color: #0a0a0a; border: 1px solid rgba(255,255,255,0.08); border-radius: 24px; overflow: hidden; box-shadow: 0 40px 100px -20px rgba(0,0,0,0.90);">
          <tr><td align="center" style="padding-top: 0;"><div style="width: 80px; height: 2px; background: linear-gradient(90deg, transparent, #00f3ff, transparent); margin: 0 auto; box-shadow: 0 0 20px rgba(0,243,255,0.25);"></div></td></tr>
          <tr><td align="center" style="padding: 44px 40px 0;">${logoBlock}</td></tr>
          <tr>
            <td align="center" style="padding: 32px 40px;">
              <div style="width: 56px; height: 56px; margin: 0 auto 20px; background: rgba(77,255,145,0.06); border: 1px solid rgba(77,255,145,0.15); border-radius: 16px; line-height: 56px; text-align: center; font-size: 28px;">🔐</div>
              <h1 style="margin: 0 0 12px; font-family: 'Poppins', 'Inter', sans-serif; font-size: 22px; font-weight: 600; letter-spacing: 4px; text-transform: uppercase; color: #ffffff;">Password Reset</h1>
              <p style="margin: 0 0 8px; font-family: 'Inter', sans-serif; font-size: 14px; line-height: 1.7; color: rgba(255,255,255,0.55);">Your password has been successfully updated.</p>
              <p style="margin: 0; font-family: 'Inter', sans-serif; font-size: 12px; line-height: 1.5; color: rgba(255,255,255,0.30);">Account: <strong style="color: rgba(255,255,255,0.70);">${email}</strong></p>
              <div style="margin-top: 24px; padding: 16px 20px; background: rgba(255,77,106,0.04); border: 1px solid rgba(255,77,106,0.10); border-radius: 14px;">
                <p style="margin: 0; font-family: 'Inter', sans-serif; font-size: 12px; line-height: 1.65; color: rgba(255,255,255,0.35);">🔒 If you did not request this change, please contact support immediately at <a href="mailto:support@ambience.com" style="color: #00f3ff; text-decoration: none;">support@ambience.com</a></p>
              </div>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 0 40px 40px;">
              <p style="margin: 0; font-family: 'Poppins', 'Inter', sans-serif; font-size: 10px; font-weight: 500; letter-spacing: 4px; text-transform: uppercase; color: rgba(255,255,255,0.12);">© ${year} AMBIENCE — All Rights Reserved</p>
            </td>
          </tr>
          <tr><td align="center" style="padding-bottom: 0;"><div style="width: 50px; height: 1px; background: linear-gradient(90deg, transparent, rgba(0,243,255,0.30), transparent); margin: 0 auto;"></div></td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
};

module.exports = { generateWelcomeEmail, generatePasswordResetConfirmEmail };
