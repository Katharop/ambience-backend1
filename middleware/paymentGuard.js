// middleware/paymentGuard.js
//
// AMBIENCE — Payment Data Protection Middleware
//
// Enterprise compliance layer that ensures NO raw financial data
// (credit card numbers, CVVs, bank account numbers) is ever stored
// in our MongoDB. All payment processing MUST go through tokenized
// third-party gateways (Stripe, Razorpay, etc.).
//
// This middleware scans request bodies for patterns matching:
//   • Credit/debit card numbers (13-19 digit sequences with Luhn patterns)
//   • CVV/CVC codes (standalone 3-4 digit codes in payment context)
//   • Raw bank account numbers
//   • Sensitive field names (cardNumber, cvv, bankAccount, etc.)

// ── Card number patterns (major networks) ──
const CARD_PATTERNS = [
  /\b4[0-9]{12}(?:[0-9]{3})?\b/,          // Visa
  /\b5[1-5][0-9]{14}\b/,                   // Mastercard
  /\b3[47][0-9]{13}\b/,                    // American Express
  /\b6(?:011|5[0-9]{2})[0-9]{12}\b/,       // Discover
  /\b3(?:0[0-5]|[68][0-9])[0-9]{11}\b/,    // Diners Club
  /\b(?:2131|1800|35\d{3})\d{11}\b/,       // JCB
  /\b[0-9]{13,19}\b/,                      // Generic long number sequences
];

// ── Sensitive field names (case-insensitive) ──
const SENSITIVE_FIELD_NAMES = [
  'cardnumber', 'card_number', 'cardnum', 'card_num',
  'creditcard', 'credit_card', 'debitcard', 'debit_card',
  'cvv', 'cvc', 'cvv2', 'cvc2', 'securitycode', 'security_code',
  'bankaccount', 'bank_account', 'accountnumber', 'account_number',
  'routingnumber', 'routing_number', 'sortcode', 'sort_code',
  'ifsc', 'ifsccode', 'ifsc_code',
  'cardexpiry', 'card_expiry', 'expirydate', 'expiry_date',
  'pan', 'pannumber', 'pan_number',
  'upipin', 'upi_pin', 'atmpin', 'atm_pin',
];

/**
 * Luhn algorithm check — validates credit card number checksum.
 * Only flags numbers that pass the Luhn check (likely real card numbers).
 */
const luhnCheck = (numStr) => {
  const digits = numStr.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let isEven = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i], 10);
    if (isEven) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
};

/**
 * Recursively scan an object for financial data patterns.
 * Returns { found: boolean, field: string, type: string } on first match.
 */
const scanForFinancialData = (obj, path = '') => {
  if (!obj || typeof obj !== 'object') {
    // Scan string values for card number patterns
    if (typeof obj === 'string') {
      const stripped = obj.replace(/[\s-]/g, '');
      // Check for card number patterns that pass Luhn
      for (const pattern of CARD_PATTERNS) {
        const match = stripped.match(pattern);
        if (match && luhnCheck(match[0])) {
          return {
            found: true,
            field: path || 'value',
            type: 'credit_card_number',
          };
        }
      }
    }
    return { found: false };
  }

  for (const key of Object.keys(obj)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const currentPath = path ? `${path}.${key}` : key;

    // Check for sensitive field names
    if (SENSITIVE_FIELD_NAMES.includes(normalizedKey)) {
      return {
        found: true,
        field: currentPath,
        type: 'sensitive_field_name',
      };
    }

    // Recurse into nested objects/arrays
    const result = scanForFinancialData(obj[key], currentPath);
    if (result.found) return result;
  }

  return { found: false };
};

/**
 * Express middleware: block requests containing raw financial data.
 */
const paymentGuard = (req, res, next) => {
  const mutationMethods = ['POST', 'PUT', 'PATCH'];
  if (!mutationMethods.includes(req.method)) return next();
  if (!req.body || typeof req.body !== 'object') return next();

  const result = scanForFinancialData(req.body);

  if (result.found) {
    console.warn(
      `[PAYMENT GUARD] ⛔ Blocked financial data in request: ` +
      `field="${result.field}" type="${result.type}" ` +
      `IP=${req.ip} path=${req.path}`
    );

    return res.status(400).json({
      success: false,
      error:
        'Financial data (card numbers, CVVs, bank details) must NEVER be sent to this server. ' +
        'Use our secure checkout powered by Stripe/Razorpay for all payments.',
      code: 'PAYMENT_DATA_BLOCKED',
    });
  }

  next();
};

module.exports = { paymentGuard, scanForFinancialData, luhnCheck };
