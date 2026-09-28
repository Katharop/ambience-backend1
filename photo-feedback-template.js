// ─────────────────────────────────────────────────────────────────────────────
// photo-feedback-template.js
//
// AMBIENCE — Premium Photo Feedback Email Template
//
// Generates a world-class HTML email for delivering personalized photo feedback.
// Uses inline CSS for maximum email client compatibility.
//
// Theme: Pitch-black (#0a0a0a) · Neon Green (#4dff91) accent for feedback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates the premium HTML email body for photo feedback delivery.
 *
 * @param {Object}  options
 * @param {string}  options.email       — Recipient email address
 * @param {string}  options.feedback    — Detailed photo analysis/feedback text
 * @param {string}  options.photoUrl    — URL to view the processed photo
 * @param {string}  [options.description] — User's original photo description
 * @param {string}  [options.logoUrl]   — Full URL to the AMBIENCE logo
 * @returns {string} Complete HTML email string
 */
const generatePhotoFeedbackEmail = ({ email, feedback, photoUrl, description = "", logoUrl }) => {
  // Format the feedback into readable sections
  const feedbackSections = feedback
    .split("\n")
    .filter((line) => line.trim())
    .map((line, idx) => {
      const isHeading = line.includes(":");
      return `
        <tr>
          <td style="padding: 12px 0;">
            <p style="
              margin: 0;
              font-family: 'Inter', 'Segoe UI', sans-serif;
              font-size: ${isHeading ? "13px" : "13px"};
              font-weight: ${isHeading ? "600" : "400"};
              line-height: 1.6;
              color: ${isHeading ? "#4dff91" : "rgba(255, 255, 255, 0.80)"};
              letter-spacing: ${isHeading ? "0.5px" : "0"};
            ">${line}</p>
          </td>
        </tr>
      `;
    })
    .join("");

  // Logo block
  const logoBlock = logoUrl
    ? `<img src="${logoUrl}" alt="AMBIENCE" width="180" height="40" style="display: block; margin: 0 auto; max-width: 180px; height: auto; filter: drop-shadow(0 0 12px rgba(77, 255, 145, 0.25));" />`
    : `<h2 style="margin: 0; font-family: 'Poppins', 'Inter', 'Segoe UI', sans-serif; font-size: 28px; font-weight: 700; letter-spacing: 10px; text-transform: uppercase; color: #4dff91; text-shadow: 0 0 20px rgba(77, 255, 145, 0.35);">AMBIENCE</h2>`;

  return `
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="color-scheme" content="dark" />
  <meta name="supported-color-schemes" content="dark" />
  <title>AMBIENCE — Your Photo Feedback</title>

  <style>
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; background-color: #000000; }
    @media only screen and (max-width: 600px) {
      .email-container { width: 100% !important; padding: 16px !important; }
      .photo-frame { width: 100% !important; max-width: 100% !important; }
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

  <div style="display: none; max-height: 0; overflow: hidden; font-size: 1px; line-height: 1px; color: #000000;">
    Your AMBIENCE photo has been analyzed. Detailed feedback inside.
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
          box-shadow: 0 40px 100px -20px rgba(0, 0, 0, 0.90), 0 0 80px -30px rgba(77, 255, 145, 0.06);
        ">

          <!-- TOP ACCENT LINE -->
          <tr>
            <td align="center" style="padding-top: 0;">
              <div style="
                width: 80px;
                height: 2px;
                background: linear-gradient(90deg, transparent, #4dff91, transparent);
                margin: 0 auto;
                box-shadow: 0 0 20px rgba(77, 255, 145, 0.25);
              "></div>
            </td>
          </tr>

          <!-- LOGO -->
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
                    <div style="width: 6px; height: 6px; background-color: #4dff91; transform: rotate(45deg); box-shadow: 0 0 10px rgba(77, 255, 145, 0.40);"></div>
                  </td>
                  <td style="height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);"></td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- GREETING -->
          <tr>
            <td align="center" style="padding: 32px 40px 0;">
              <div style="width: 48px; height: 48px; margin: 0 auto 20px; background: rgba(77, 255, 145, 0.06); border: 1px solid rgba(77, 255, 145, 0.15); border-radius: 14px; line-height: 48px; text-align: center; font-size: 22px;">📸</div>

              <h1 style="
                margin: 0 0 8px;
                font-family: 'Poppins', 'Inter', 'Segoe UI', sans-serif;
                font-size: 22px;
                font-weight: 600;
                letter-spacing: 2px;
                color: #ffffff;
              ">Your Photo Feedback</h1>

              <p style="
                margin: 0 0 16px;
                font-family: 'Inter', 'Segoe UI', sans-serif;
                font-size: 14px;
                font-weight: 400;
                line-height: 1.6;
                color: rgba(255, 255, 255, 0.50);
              ">Your ambience photo has been analyzed and processed</p>
            </td>
          </tr>

          <!-- PHOTO PREVIEW -->
          <tr>
            <td align="center" style="padding: 32px 40px 0;">
              <div style="
                display: inline-block;
                width: 100%;
                max-width: 400px;
                padding: 2px;
                background: linear-gradient(135deg, #4dff91, rgba(77, 255, 145, 0.3));
                border-radius: 16px;
              ">
                <img 
                  src="${photoUrl}" 
                  alt="Your processed photo" 
                  width="400" 
                  height="auto"
                  class="photo-frame"
                  style="
                    display: block;
                    width: 100%;
                    height: auto;
                    border-radius: 14px;
                    max-width: 400px;
                  "
                />
              </div>
            </td>
          </tr>

          <!-- FEEDBACK SECTION -->
          <tr>
            <td align="center" style="padding: 36px 40px 0;">
              <div style="
                display: inline-block;
                width: 100%;
                padding: 28px 32px;
                background: rgba(77, 255, 145, 0.02);
                border: 1px solid rgba(77, 255, 145, 0.12);
                border-radius: 20px;
                box-shadow: 0 0 40px rgba(77, 255, 145, 0.05), inset 0 0 30px rgba(77, 255, 145, 0.02);
              ">
                <p style="
                  margin: 0 0 20px;
                  font-family: 'Inter', 'Segoe UI', sans-serif;
                  font-size: 9px;
                  font-weight: 500;
                  letter-spacing: 3px;
                  text-transform: uppercase;
                  color: rgba(77, 255, 145, 0.60);
                  text-align: center;
                ">Detailed Analysis</p>

                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                  ${feedbackSections}
                </table>
              </div>
            </td>
          </tr>

          <!-- SECURITY FOOTER -->
          <tr>
            <td align="center" style="padding: 36px 40px 24px;">
              <p style="
                margin: 0;
                font-family: 'Inter', 'Segoe UI', sans-serif;
                font-size: 10px;
                font-weight: 400;
                line-height: 1.6;
                color: rgba(255, 255, 255, 0.30);
                text-align: center;
                letter-spacing: 0.3px;
              ">
                📧 Email: <strong style="color: rgba(255, 255, 255, 0.50);">${email}</strong><br/>
                This feedback was generated for your exclusive analysis.<br/>
                Thank you for trusting AMBIENCE.
              </p>
            </td>
          </tr>

          <!-- BOTTOM ACCENT LINE -->
          <tr>
            <td align="center" style="padding-bottom: 0;">
              <div style="
                width: 80px;
                height: 2px;
                background: linear-gradient(90deg, transparent, #4dff91, transparent);
                margin: 0 auto;
                box-shadow: 0 0 20px rgba(77, 255, 145, 0.25);
              "></div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>
  `;
};

module.exports = { generatePhotoFeedbackEmail };
