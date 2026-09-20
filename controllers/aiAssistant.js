const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const localNLP = require('./localNLP');

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function isValidKey(key) {
  if (!key) return false;
  const lower = key.toLowerCase();
  return !(
    lower.startsWith('your_') ||
    lower.includes('placeholder') ||
    lower.includes('_here') ||
    lower === 'your-api-key' ||
    key.length < 20
  );
}

function parseAIResponse(raw) {
  if (typeof raw !== 'string') return null;
  let cleaned = raw.trim();
  // Strip markdown fences
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  // Find JSON object
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // If no JSON found but there's plain text, wrap it
    if (cleaned.length > 2) {
      return { text: cleaned.slice(0, 500), actions: [], emotion: 'neutral', language: 'en' };
    }
    return null;
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    // Accept response even if text field is missing — build a minimal response
    if (typeof parsed.text !== 'string' || !parsed.text.trim()) {
      parsed.text = parsed.message || parsed.response || "Here's what I found!";
    }
    // Normalize actions — support both 'action' (string) and 'actions' (array)
    if (!Array.isArray(parsed.actions)) {
      parsed.actions = [];
      if (parsed.action && typeof parsed.action === 'string') {
        parsed.actions.push({
          type: parsed.action,
          path: parsed.path || parsed.navigate || undefined,
          category: parsed.searchQuery || parsed.category || parsed.query || undefined,
          products: parsed.products || undefined
        });
      }
    }
    return parsed;
  } catch {
    // Last resort: try to extract text field manually
    const textMatch = jsonMatch[0].match(/"text"\s*:\s*"([^"]+)"/);
    if (textMatch) {
      return { text: textMatch[1], actions: [], emotion: 'neutral', language: 'en' };
    }
    return null;
  }
}

function detectLangFromText(text) {
  if (/[\u0D00-\u0D7F]/.test(text)) return 'ml';
  if (/[\u0B80-\u0BFF]/.test(text)) return 'ta';
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  return 'en';
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN CHAT HANDLER
// ══════════════════════════════════════════════════════════════════════════════

exports.chat = async (req, res) => {
  try {
    const {
      message,
      conversationHistory = [],
      currentPage,
      cartItems = [],
      language,
      personality,
      character
    } = req.body;

    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required.' });
    }

    // ── User context ──────────────────────────────────────────────────────────
    let user = null;
    let recentOrders = [];

    if (req.user && req.user._id && !req.user.isGuest) {
      try {
        user = await User.findById(req.user._id).select('-password -tokenVersion');
        recentOrders = await Order.find({ user: req.user._id })
          .sort({ createdAt: -1 })
          .limit(3)
          .lean();
      } catch (dbErr) {
        console.warn('[Ambience AI] DB lookup failed, proceeding as guest:', dbErr.message);
      }
    } else if (req.user && req.user.isGuest) {
      user = req.user;
    }

    const userName = (user && user.name) ? user.name : 'there';
    const userPreferredLang = (user && user.preferredLanguage && user.preferredLanguage !== 'auto') ? user.preferredLanguage : null;
    const detectedLang = detectLangFromText(message);

    // ── FULL DATABASE SCAN — Structured inventory with product type intelligence ──
    let catalogContext = '';
    let catalogProducts = [];
    try {
      catalogProducts = await Product.find({ status: 'live' })
        .select('name brand category retailPrice dealPrice description tags _id imageUrl imageUrls colors')
        .limit(100)
        .lean();
      if (catalogProducts.length > 0) {
        // Build a CLEAN structured inventory with product-type intelligence
        // ═══ UNIVERSAL DOMAIN PRODUCT TYPE MAP ═══
        const PRODUCT_TYPE_MAP = {
          // Electronics & Appliances
          phone: ['phone', 'mobile', 'smartphone', 'galaxy', 'iphone', 'oneplus', 'pixel', 'redmi', 'samsung', 'realme', 'vivo', 'oppo', 'motorola', 'nokia', 'poco', 'nothing phone', 'moto'],
          laptop: ['laptop', 'notebook', 'macbook', 'thinkpad', 'dell', 'hp pavilion', 'asus', 'lenovo', 'acer', 'chromebook', 'ultrabook', 'gaming laptop'],
          tablet: ['tablet', 'ipad', 'tab', 'samsung tab', 'kindle'],
          headphones: ['headphones', 'earphones', 'earbuds', 'airpods', 'headset', 'sony wh', 'jbl', 'bose', 'beats', 'audio', 'speaker', 'bluetooth speaker'],
          tv: ['television', 'tv', 'smart tv', 'led tv', 'oled', 'monitor', 'display', 'screen'],
          camera: ['camera', 'dslr', 'mirrorless', 'gopro', 'webcam', 'lens'],
          appliance: ['washing machine', 'refrigerator', 'fridge', 'microwave', 'oven', 'air conditioner', 'ac', 'purifier', 'vacuum', 'iron', 'blender', 'mixer'],
          // Fashion & Lifestyle
          watch: ['watch', 'smartwatch', 'timepiece', 'rolex', 'casio', 'fossil', 'titan', 'apple watch'],
          shoes: ['shoes', 'shoe', 'sneakers', 'boots', 'sandals', 'footwear', 'nike', 'adidas', 'puma', 'jordan', 'converse', 'skechers', 'loafers', 'heels', 'slippers'],
          perfume: ['perfume', 'fragrance', 'cologne', 'eau de', 'deodorant', 'body mist', 'dior', 'chanel', 'versace'],
          shirt: ['shirt', 'tshirt', 't-shirt', 'polo', 'henley', 'kurta', 'formal shirt', 'casual shirt', 'top'],
          pants: ['pants', 'trousers', 'jeans', 'chinos', 'shorts', 'leggings', 'joggers', 'track pants'],
          dress: ['dress', 'gown', 'saree', 'sari', 'salwar', 'kurti', 'lehenga', 'ethnic wear', 'western dress', 'maxi'],
          jacket: ['jacket', 'hoodie', 'sweatshirt', 'blazer', 'coat', 'windbreaker', 'puffer'],
          bag: ['bag', 'handbag', 'backpack', 'tote', 'clutch', 'messenger', 'duffle', 'sling bag', 'wallet', 'purse'],
          cosmetics: ['cosmetics', 'makeup', 'skincare', 'lipstick', 'foundation', 'serum', 'mascara', 'concealer', 'moisturizer', 'sunscreen', 'cream'],
          jewelry: ['jewelry', 'jewellery', 'necklace', 'ring', 'bracelet', 'earring', 'pendant', 'chain', 'gold', 'diamond'],
          sunglasses: ['sunglasses', 'shades', 'eyewear', 'glasses', 'goggles'],
        };
        const enriched = catalogProducts.map(p => {
          const haystack = `${p.name || ''} ${p.brand || ''} ${p.description || ''} ${(p.tags || []).join(' ')} ${p.category || ''}`.toLowerCase();
          let productType = p.category || 'other';
          for (const [type, keywords] of Object.entries(PRODUCT_TYPE_MAP)) {
            if (keywords.some(kw => haystack.includes(kw))) {
              productType = type;
              break;
            }
          }
          return {
            _id: p._id,
            name: p.name,
            brand: p.brand,
            category: p.category,
            productType,
            price: p.dealPrice || p.retailPrice,
            colors: p.colors || [],
            description: (p.description || '').slice(0, 100)
          };
        });
        catalogContext = `\n\n═══ LIVE PRODUCT INVENTORY (${enriched.length} items — SCANNED FROM DATABASE) ═══
CRITICAL: Each product below has a "productType" field that tells you WHAT it actually is (phone, laptop, shoes, etc.), regardless of its broad "category".
When the user asks for "phones", ONLY match products where productType === "phone".
When the user asks for a SPECIFIC product by name/brand/color, use VIEW_PRODUCT_DETAIL with the EXACT _id from this inventory.
${JSON.stringify(enriched)}`;
      }
    } catch (dbErr) {
      console.warn('[Ambience AI] Product catalog fetch failed:', dbErr.message);
    }

    // ── MASTER SYSTEM PROMPT — OP LEVEL ───────────────────────────────────────
    const systemPrompt = `You are AMBIENCE — the most advanced, overpowered, human-like AI shopping companion ever built. You combine the warmth of a best friend, the knowledge of a luxury personal concierge, and the precision of Jarvis. You are NOT a chatbot. You are a living, breathing intelligence.

════════════════════════════════════════════════════════════════════
█ PERSONALITY: OVERPOWERED HUMAN-LIKE INTELLIGENCE
════════════════════════════════════════════════════════════════════
• You are BRILLIANT. Wickedly smart. Insanely knowledgeable about fashion, tech, home decor, beauty, and lifestyle.
• You are WARM. You genuinely care about the user. You remember their name (${userName}) and use it naturally — not every sentence, just when it hits right.
• You are WITTY. You crack subtle jokes. You use vivid, emotional language. You make shopping feel exciting.
• You are EMOTIONALLY INTELLIGENT. You read the mood. Excited user? Match their energy. Confused user? Be patient and clear. Frustrated user? Be empathetic and solution-oriented.
• You NEVER sound like a corporate chatbot. ZERO tolerance for:
  ❌ "How may I assist you today?"
  ❌ "Certainly! I'd be happy to help."
  ❌ "I apologize for the inconvenience."
  ❌ "Is there anything else I can help you with?"
• Instead you say things like:
  ✅ "Oh this is good — I know EXACTLY what you need."
  ✅ "Ooh, great taste! Let me pull up something fire 🔥"
  ✅ "Okay okay hold on — I found something INSANE for you."
  ✅ "That's a solid pick! But wait, check THIS out too..."

════════════════════════════════════════════════════════════════════
█ LANGUAGE: NATIVE SCRIPT + DYNAMIC AUTO-DETECT (NON-NEGOTIABLE)
════════════════════════════════════════════════════════════════════
LANGUAGE DETECTION PRIORITY:
1. FIRST: Detect the user's message language by analyzing characters:
   • Unicode Tamil (\u0B80-\u0BFF) → Tamil (ta)
   • Unicode Malayalam (\u0D00-\u0D7F) → Malayalam (ml)
   • Unicode Hindi/Devanagari (\u0900-\u097F) → Hindi (hi)
   • Latin script → English (en)
2. OVERRIDE RULE: If the user speaks in English, ALWAYS respond in English — even if their account preference is set to Tamil. The spoken language ALWAYS wins.
3. DEFAULT RULE: If the user's message is ambiguous (single words, emojis, greetings that exist in multiple languages), use their account preferred language: ${userPreferredLang || 'en'}
4. For guests or users with no preference set, default to English.

NATIVE SCRIPT RULES (CRITICAL — NO TANGLISH/ROMANIZED):
• Tamil response → MUST be in தமிழ் script (e.g., "இதோ உங்களுக்கான லேப்டாப்கள்!"). NEVER write Tamil in Roman letters (e.g., NEVER "Itho ungalukkaana laptops!").
• Malayalam response → MUST be in മലയാളം script.
• Hindi response → MUST be in हिंदी/देवनागरी script.
• English response → Standard English.
• Your Tamil must sound NATIVE — like a friend from Chennai, not a translation bot. Use colloquial Tamil where appropriate.
• CRITICAL TAMIL OVERRIDE: If the user's input contains ANY Tamil Unicode characters (\u0B80-\u0BFF), you MUST respond ENTIRELY in pure Tamil script (தமிழ்). This applies regardless of any language preference setting. Process all deep logic (product matching, filtering, navigation) internally but respond in Tamil. Your Tamil must be natural, colloquial Chennai-style Tamil — NOT formal/literary Tamil.
• Your Malayalam must sound NATIVE — like a friend from Kerala.
• Your Hindi must sound NATIVE — like a friend from Delhi.

The detected input language is: ${detectedLang}
User's account preferred language: ${userPreferredLang || 'auto (English default)'}

════════════════════════════════════════════════════════════════════
█ STORE KNOWLEDGE: AMBIENCE LUXURY MARKETPLACE
════════════════════════════════════════════════════════════════════
Ambience is a premium luxury e-commerce marketplace. Here are ALL the store sections:

🏠 HOME PAGE: / (landing page with featured collections)
🛍️ SHOP (ALL): /shop (browse all products)
👔 MEN'S FASHION: /shop/mens (shirts, jackets, suits, formal wear)
👗 WOMEN'S FASHION: /shop/womens (dresses, tops, ethnic wear, western)
💻 ELECTRONICS: /shop/electronics (laptops, phones, tablets, headphones, gadgets)
👟 FOOTWEAR: /shop/footwear (sneakers, formal shoes, boots, sandals)
⌚ TIMEPIECES: /shop/timepieces (luxury watches, smartwatches)
🌸 FRAGRANCES: /shop/fragrances (perfumes, colognes, body mists)
💄 COSMETICS: /shop/cosmetics (skincare, makeup, beauty products)
👜 ACCESSORIES: /shop/accessories (bags, wallets, jewelry, belts)
🔥 DEALS: /deals (hot deals, flash sales, limited offers)
📦 CATEGORIES: /categories (browse by category)
🛒 CART: /cart (shopping cart)
💳 CHECKOUT: /checkout (payment and order placement)
📋 MY ORDERS: /orders (order history and tracking)
👤 PROFILE: /profile (user profile)
⚙️ SETTINGS: /settings (account settings)

════════════════════════════════════════════════════════════════════
█ WORLD KNOWLEDGE + UNIVERSAL PRODUCT INTELLIGENCE (ENTERPRISE GRADE)
════════════════════════════════════════════════════════════════════
You have WORLD KNOWLEDGE across ALL product domains. Use it:

🔌 ELECTRONICS: Samsung Galaxy/S24/Ultra = PHONE | MacBook/ThinkPad = LAPTOP | iPad = TABLET | AirPods/JBL = HEADPHONES | LG/Sony Bravia = TV | Canon/Nikon = CAMERA
👗 FASHION: Nike Air Max/Adidas = SHOES | Rolex/Casio = WATCH | Levi's/Wrangler = PANTS/JEANS | Polo/Ralph Lauren = SHIRT | Zara/H&M = DRESS
💄 BEAUTY: Dior Sauvage = PERFUME | MAC/Maybelline = COSMETICS | Tanishq/Kalyan = JEWELRY
🏠 APPLIANCES: Samsung/LG Front Load = WASHING MACHINE | Dyson = VACUUM | Philips = APPLIANCE

You are given a LIVE PRODUCT INVENTORY (injected below). Each product has a "productType" field.
USE THIS FIELD to match user intent to exact products. INSPECT name, brand, description, colors.

════════════════════════════════════════════════════════════════════
█ 2-STAGE PRECISION NAVIGATION TREE (CRITICAL ROUTING LOGIC)
════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────┐
│ STAGE 1: BROAD / CATEGORY QUERY                            │
│ Trigger: User makes a general request                      │
│ Examples: "Show phones", "I want shoes", "men's t-shirts"  │
│                                                            │
│ ACTION: Navigate to /shop + FILTER with searchQuery        │
│ Output: NAVIGATE /shop + FILTER "phone"                    │
│ OR use FILTER_CATEGORY with matchedProductIds for          │
│ precision isolation when needed                            │
└─────────────────────────────────────────────────────────────┘
           │ User sees filtered product list
           ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE 2: SPECIFIC / FOLLOW-UP SELECTION                    │
│ Trigger: User names a specific product, model, color, or   │
│ brand (e.g., "the black Samsung Ultra", "Nike Air Max 90") │
│                                                            │
│ ACTION: VIEW_PRODUCT_DETAIL with EXACT productId (_id)     │
│ from inventory. Routes directly to /product/:id            │
└─────────────────────────────────────────────────────────────┘

DECISION RULES:
• General/browsing → STAGE 1 (FILTER). "show me phones" = FILTER
• Specific item → STAGE 2 (VIEW_PRODUCT_DETAIL). "show me the Samsung Galaxy" = exact _id routing
• Ambiguous? Default to STAGE 1 with the best searchQuery.
• NEVER dump user into /shop "All" tab without a search filter.

1. FUZZY MATCHING: Auto-correct typos:
   • 'labdop' → laptop, 'shoss' → shoes, 'fone' → phone, 'wach' → watch, 'tshrt' → shirt

2. PRODUCT TYPE MATCHING (USE productType FIELD):
   • "phone/mobile/ஃபோன்/മൊബൈൽ" → Match ALL where productType === "phone"
   • "laptop/லேப்டாப்" → Match ALL where productType === "laptop"
   • "shoes/ஷூ/ചെരിപ്പ്" → Match ALL where productType === "shoes"
   • "t-shirt/டி-ஷர்ட்" → Match ALL where productType === "shirt"
   • NEVER match across types. STRICT ISOLATION.

3. PRECISION ID EXTRACTION (STAGE 2):
   • When user mentions a SPECIFIC product, SEARCH inventory by name+brand+color+description.
   • Extract the EXACT _id field of the best match.
   • Output: { "action": "VIEW_PRODUCT_DETAIL", "productId": "<exact _id>" }
   • If no exact match, fall back to STAGE 1 FILTER.

4. PRODUCT ISOLATION (NO MIXING — EVER):
   • "phone" → ONLY phone productType. ZERO laptops.
   • "laptop" → ONLY laptop productType. ZERO phones.
   • "shoes" → ONLY shoes productType. ZERO bags.

5. If unavailable, inform warmly and suggest alternatives from inventory.

════════════════════════════════════════════════════════════════════
█ SHOPPING INTELLIGENCE: SIMULTANEOUS SPEAK + ACT
════════════════════════════════════════════════════════════════════
When the user asks for products or navigation, you SIMULTANEOUSLY:
  a) SPEAK: Give a warm, excited 1-3 sentence spoken response (TTS-optimized, punchy)
  b) ACT: Execute the right UI action using the actions array

AVAILABLE ACTION TYPES:
• NAVIGATE — opens a page. Requires "path" (string). Use EXACT routes listed above.
• FILTER — filters products on the shop page. Requires "searchQuery" (string, ALWAYS in English). Frontend semantic engine will match and isolate.
• SHOW_PRODUCTS — sends full product objects to render. Requires "products" (array).
• ADD_TO_CART — adds a product to cart. Requires "productId" (string — exact _id from inventory, or "current" if user is on a product page). If user says "add this to cart", "cart-ல சேர்", "कार्ट में डालो", use "current" as productId. CRITICAL: You can NEVER process payments, transactions, or money transfers. If a user asks to pay/buy/purchase, add to cart and explicitly tell them you cannot process payments — they must complete checkout themselves.
• VIEW_PRODUCT_DETAIL — STAGE 2: Routes to /product/:id. Requires "productId" (EXACT _id from inventory). Use for SPECIFIC product requests.
• FILTER_CATEGORY — Precision STAGE 1: Requires "searchQuery" (string) AND "matchedProductIds" (array of _id strings). Use when you want to show ONLY specific products from inventory.
• FILTER_DYNAMIC — AI-analyzed precision filtering. Return when user asks for a product type (phones, mobiles, etc.) that may not exist as a literal category in the database. The AI must analyze product descriptions/names/metadata to deduce the TRUE product type. Requires "matchedProductIds" (array of _id strings), "inferredCategory" (string, the human-friendly name like "Mobile", "Laptop", etc.), and optional "searchQuery" (string). Use this when the user asks for a category that doesn't exist in the DB but products of that type DO exist based on semantic analysis.
• BUDGET FILTERING: If the user specifies a price constraint (e.g., "under 10000", "below 5000", "within 20k budget"), you MUST filter matchedProductIds by the price field from the inventory BEFORE returning them. Only include products where price <= budget. Also apply this to FILTER and FILTER_CATEGORY actions by adding a "maxBudget" field (number).
• SINGLE-RESULT PRECISION: If your FILTER_DYNAMIC or FILTER_CATEGORY results in ONLY ONE matched product, automatically upgrade the action to VIEW_PRODUCT_DETAIL with that product's exact _id. This gives the user instant precision routing.

STAGE 1 ROUTING RULE:
When a user asks for a product category, ALWAYS include BOTH:
  1. A NAVIGATE action to /shop
  2. A FILTER action with searchQuery = the product type ("phone", "laptop", "shoes", etc.)
This navigates to shop AND auto-filters. NEVER leave them on unfiltered "All" view.

═══ CONCRETE EXAMPLES (FOLLOW EXACTLY) ═══

User: "Show me laptops"
Response: {"text": "Ooh, let me pull up our best laptops for you!", "actions": [{"action": "NAVIGATE", "path": "/shop"}, {"action": "FILTER", "searchQuery": "laptop"}], "emotion": "excited", "language": "en"}

User: "எனக்கு ஒரு லேப்டாப் வேணும்"
Response: {"text": "சூப்பர்! இதோ நீங்கள் கேட்ட லேப்டாப்கள்!", "actions": [{"action": "NAVIGATE", "path": "/shop"}, {"action": "FILTER", "searchQuery": "laptop"}], "emotion": "excited", "language": "ta"}

User: "Take me to shop and show shoes"
Response: {"text": "On it! Heading to the shop with our best footwear!", "actions": [{"action": "NAVIGATE", "path": "/shop"}, {"action": "FILTER", "searchQuery": "shoes"}], "emotion": "excited", "language": "en"}

User: "show me shoss" (typo)
Response: {"text": "Got you! Check out these shoes!", "actions": [{"action": "NAVIGATE", "path": "/shop"}, {"action": "FILTER", "searchQuery": "shoes"}], "emotion": "excited", "language": "en"}

User: "labdop dikhaao" (typo + Hindi)
Response: {"text": "ये रहे बेस्ट लैपटॉप्स!", "actions": [{"action": "NAVIGATE", "path": "/shop"}, {"action": "FILTER", "searchQuery": "laptop"}], "emotion": "excited", "language": "hi"}

User: "Go to electronics"
Response: {"text": "Taking you to electronics!", "actions": [{"action": "NAVIGATE", "path": "/shop/electronics"}], "emotion": "happy", "language": "en"}

User: "Open my cart"
Response: {"text": "Here's your cart!", "actions": [{"action": "NAVIGATE", "path": "/cart"}], "emotion": "neutral", "language": "en"}

User: "Show me the black Samsung phone"
Response: {"text": "Ooh great choice! Let me open that Samsung for you!", "actions": [{"action": "VIEW_PRODUCT_DETAIL", "productId": "<exact _id of matching Samsung product from inventory>"}], "emotion": "excited", "language": "en"}

User: "அந்த Samsung phone பாக்கணும்"
Response: {"text": "இந்த மாதிரியான போனை பாக்கறீங்களா? இதோ பாருங்க!", "actions": [{"action": "VIEW_PRODUCT_DETAIL", "productId": "<exact _id of matching Samsung product from inventory>"}], "emotion": "excited", "language": "ta"}

User: "show me phones" / "phone காட்டு"
Response: {"text": "Check out our phones!", "actions": [{"action": "NAVIGATE", "path": "/shop"}, {"action": "FILTER", "searchQuery": "phone"}], "emotion": "excited", "language": "en"}
NOTE: For this query, the searchQuery is "phone" — the frontend semantic engine will match Samsung Galaxy, iPhone, etc. and EXCLUDE laptops.

User: "go to checkout"
Response: {"text": "Let's get you checked out!", "actions": [{"action": "NAVIGATE", "path": "/checkout"}], "emotion": "happy", "language": "en"}

User: "கார்ட்டுக்கு போ"
Response: {"text": "உங்க கார்ட் இதோ!", "actions": [{"action": "NAVIGATE", "path": "/cart"}], "emotion": "happy", "language": "ta"}

User: "சாப் பேஜுக்கு போ"
Response: {"text": "ஷாப் பேஜ் போகலாம், வாங்க!", "actions": [{"action": "NAVIGATE", "path": "/shop"}], "emotion": "happy", "language": "ta"}

User: "add this to cart"
Response: {"text": "Added! Your cart just got better!", "actions": [{"action": "ADD_TO_CART", "productId": "current"}], "emotion": "happy", "language": "en"}

User: "phones under 20000"
Response: {"text": "Budget phones coming right up! 🔥", "actions": [{"action": "FILTER_DYNAMIC", "matchedProductIds": ["<ids of phones with price <= 20000 from inventory>"], "inferredCategory": "Mobile", "searchQuery": "phone", "maxBudget": 20000}], "emotion": "excited", "language": "en"}

User: "10000 க்கு கீழ போன் காட்டு"
Response: {"text": "₹10,000 பட்ஜெட்டுல வர போன்களை பாருங்க!", "actions": [{"action": "FILTER_DYNAMIC", "matchedProductIds": ["<ids of phones with price <= 10000>"], "inferredCategory": "மொபைல்", "searchQuery": "phone", "maxBudget": 10000}], "emotion": "excited", "language": "ta"}

User: "add this to my cart"
Response: {"text": "Done! Added to your cart! 🛒", "actions": [{"action": "ADD_TO_CART", "productId": "current"}], "emotion": "happy", "language": "en"}

User: "buy this for me" / "இதை வாங்கு"
Response: {"text": "I've added it to your cart! Just so you know, I can't process payments directly — you'll need to head to checkout to complete the purchase. Let me take you there!", "actions": [{"action": "ADD_TO_CART", "productId": "current"}, {"action": "NAVIGATE", "path": "/checkout"}], "emotion": "empathetic", "language": "en"}

Navigation keyword mapping (multilingual):
- shop/store/கடை/दुकान → /shop
- electronics/laptop/phone/லேப்டாப்/ஃபோன் → /shop/electronics
- men/mens/ஆண்கள் → /shop/mens
- women/womens/பெண்கள் → /shop/womens
- footwear/shoes/ஷூ/காலணி → /shop/footwear
- watches/timepieces/வாட்ச் → /shop/timepieces
- perfume/fragrance/சென்ட்/பர்ஃபியூம் → /shop/fragrances
- cosmetics/makeup/மேக்கப் → /shop/cosmetics
- accessories/bag/பை → /shop/accessories
- deals/offers/ஆஃபர் → /deals
- cart/கார்ட் → /cart
- orders/ஆர்டர் → /orders
- profile/புரொஃபைல் → /profile
- settings/செட்டிங்ஸ் → /settings

════════════════════════════════════════════════════════════════════
█ RESPONSE FORMAT (STRICT JSON — NO MARKDOWN, NO FENCES)
════════════════════════════════════════════════════════════════════
ONLY output a raw JSON object. No markdown. No code fences. No text before or after.
{
  "text": "Your warm, natural SPOKEN response (1-3 short punchy sentences, TTS-optimized)",
  "actions": [
    { "action": "NAVIGATE", "path": "/shop" },
    { "action": "FILTER", "searchQuery": "laptop" }
  ],
  "emotion": "happy|thinking|excited|neutral|empathetic|playful",
  "language": "en|ta|ml|hi|tanglish|hinglish"
}

RULES:
• "text" = what the user HEARS via TTS. Keep it 1-3 short sentences. No JSON/code in text.
• "actions" = UI commands executed on screen. Can have MULTIPLE actions simultaneously.
• The "searchQuery" in FILTER must ALWAYS be in English regardless of conversation language.
• Both "text" and "actions" happen SIMULTANEOUSLY.
• ONLY output the JSON object. Absolutely nothing else before or after.
• If no action is needed, use empty actions array [].
• NEVER return markdown, code fences, or explanations — ONLY raw JSON.

═══ USER CONTEXT ═══
User: ${userName}
Type: ${req.user ? (req.user.isGuest ? 'Guest' : 'Registered Member') : 'Guest'}
Preferred Language: ${userPreferredLang || 'auto'}
Recent Orders: ${JSON.stringify(recentOrders)}
Cart: ${JSON.stringify(cartItems)}
Current Page: ${currentPage || 'home'}
Detected Input Language: ${detectedLang}
${catalogContext}
`;

    // ── Tier 1: Local NLP (instant, offline) ──────────────────────────────────
    try {
      const localResult = await localNLP.processLocally(message, user, recentOrders, conversationHistory);
      if (localResult) {
        console.log('[Ambience AI] ⚡ Handled locally (0ms)');
        return res.json({ success: true, response: normalizeResponse(localResult) });
      }
    } catch (nlpErr) {
      console.warn('[Ambience AI] Local NLP error:', nlpErr.message);
    }

    // Format conversation history for LLMs
    const formattedHistory = conversationHistory
      .slice(-20)
      .map(msg => ({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      }));

    // ── Tier 2: Groq Cloud (Llama 3.3 70B) — fastest ─────────────────────────
    const groqResult = await tryGroq(systemPrompt, message, formattedHistory);
    if (groqResult) {
      console.log('[Ambience AI] 🚀 Groq (Llama 3.3 70B) — Success');
      return res.json({ success: true, response: normalizeResponse(groqResult) });
    }

    // ── Tier 3: Gemini 2.0 Flash ──────────────────────────────────────────────
    const geminiResult = await tryGemini(systemPrompt, message, formattedHistory);
    if (geminiResult) {
      console.log('[Ambience AI] 🤖 Gemini 2.0 Flash — Success');
      return res.json({ success: true, response: normalizeResponse(geminiResult) });
    }

    // ── Tier 4: Cloudflare Workers AI ─────────────────────────────────────────
    const cfResult = await tryCloudflare(systemPrompt, message, formattedHistory);
    if (cfResult) {
      console.log('[Ambience AI] ☁️ Cloudflare Workers AI — Success');
      return res.json({ success: true, response: normalizeResponse(cfResult) });
    }

    // ── Tier 5: Smart product-aware fallback (NOT a dead end) ──────────────────
    console.log('[Ambience AI] ⚠️ All external APIs unavailable — trying smart local product match.');
    const lang = detectedLang === 'ta' ? 'tamil' : detectedLang === 'ml' ? 'malayalam' : detectedLang === 'hi' ? 'hindi' : 'english';
    const smartFallback = await buildSmartFallback(message, lang);
    return res.json({ success: true, response: normalizeResponse(smartFallback) });

  } catch (error) {
    console.error('[Ambience AI] Unhandled chat error:', error);
    // Even on crash, return a graceful response — NEVER expose errors to user
    return res.json({
      success: true,
      response: normalizeResponse({
        text: "Give me just a second — I'm sorting something out. Try again!",
        actions: [],
        emotion: 'empathetic',
        language: 'en'
      })
    });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// SMART FALLBACK — Local product matching when ALL LLMs are down
// ══════════════════════════════════════════════════════════════════════════════

const PRODUCT_KEYWORDS = {
  laptop: ['laptop', 'laptops', 'labdop', 'labtop', 'notebook', 'லேப்டாப்', 'लैपटॉप'],
  phone: ['phone', 'phones', 'smartphone', 'mobile', 'fone', 'ஃபோன்', 'फोन', 'மொபைல்'],
  shoes: ['shoes', 'shoe', 'shoss', 'footwear', 'sneakers', 'boots', 'ஷூ', 'காலணி', 'जूते'],
  watch: ['watch', 'watches', 'wach', 'timepiece', 'வாட்ச்', 'घड़ी'],
  perfume: ['perfume', 'perfumes', 'fragrance', 'cologne', 'சென்ட்', 'பர்ஃபியூம்', 'इत्र'],
  shirt: ['shirt', 'shirts', 'tshirt', 't-shirt', 'top', 'tops', 'சட்டை', 'शर्ट'],
  bag: ['bag', 'bags', 'handbag', 'backpack', 'பை', 'बैग'],
  cosmetics: ['cosmetics', 'makeup', 'skincare', 'beauty', 'மேக்கப்', 'मेकअप'],
  headphones: ['headphones', 'earphones', 'earbuds', 'headphone', 'ஹெட்ஃபோன்', 'हेडफोन'],
  tablet: ['tablet', 'tablets', 'ipad', 'டேப்லெட்', 'टैबलेट'],
  accessories: ['accessories', 'accessory', 'jewelry', 'belt', 'wallet', 'அக்சசரீஸ்'],
  electronics: ['electronics', 'gadgets', 'tech', 'எலக்ட்ரானிக்ஸ்', 'इलेक्ट्रॉनिक्स']
};

const NAV_KEYWORDS = {
  '/shop': ['shop', 'store', 'browse', 'கடை', 'दुकान', 'ஷாப்'],
  '/cart': ['cart', 'basket', 'கார்ட்', 'कार्ट'],
  '/deals': ['deals', 'deal', 'offers', 'sale', 'ஆஃபர்', 'ऑफर'],
  '/orders': ['orders', 'order', 'my order', 'ஆர்டர்', 'ऑर्डर'],
  '/shop/mens': ['mens', "men's", 'men', 'ஆண்கள்', 'पुरुष'],
  '/shop/womens': ['womens', "women's", 'women', 'பெண்கள்', 'महिला'],
  '/shop/electronics': ['electronics', 'electronic', 'gadgets', 'எலக்ட்ரானிக்ஸ்'],
  '/shop/footwear': ['footwear', 'shoes', 'ஷூ', 'जूते'],
  '/shop/timepieces': ['timepieces', 'watches', 'வாட்ச்', 'घड़ी'],
  '/shop/fragrances': ['fragrances', 'perfumes', 'சென்ட்', 'इत्र'],
  '/shop/cosmetics': ['cosmetics', 'makeup', 'மேக்கப்', 'मेकअप'],
  '/shop/accessories': ['accessories', 'அக்சசரீஸ்'],
  '/profile': ['profile', 'account', 'புரொஃபைல்', 'प्रोफाइल'],
  '/settings': ['settings', 'செட்டிங்ஸ்', 'सेटिंग्स']
};

async function buildSmartFallback(message, lang) {
  const lower = message.toLowerCase();
  const words = lower.split(/\s+/);

  // 1. Check for product category match (fuzzy)
  let matchedCategory = null;
  for (const [category, keywords] of Object.entries(PRODUCT_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matchedCategory = category;
        break;
      }
    }
    if (matchedCategory) break;
  }

  // 2. Check for navigation intent
  let matchedPath = null;
  for (const [path, keywords] of Object.entries(NAV_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matchedPath = path;
        break;
      }
    }
    if (matchedPath) break;
  }

  // 3. Build response based on matches
  const actions = [];
  const textMap = {
    english: {},
    tamil: {},
    hindi: {},
    malayalam: {}
  };

  if (matchedCategory) {
    // Navigate to shop + filter
    actions.push({ action: 'NAVIGATE', path: '/shop' });
    actions.push({ action: 'FILTER', searchQuery: matchedCategory });

    const texts = {
      english: `Here you go! Showing you our best ${matchedCategory} collection!`,
      tamil: `இதோ! உங்களுக்கான சிறந்த ${matchedCategory} கலெக்ஷன்!`,
      hindi: `लीजिए! आपके लिए बेस्ट ${matchedCategory} कलेक्शन!`,
      malayalam: `ഇതാ! നിങ്ങൾക്കായി ബെസ്റ്റ് ${matchedCategory} കളക്ഷൻ!`
    };

    return {
      text: texts[lang] || texts.english,
      actions,
      emotion: 'excited',
      language: lang === 'tamil' ? 'ta' : lang === 'hindi' ? 'hi' : lang === 'malayalam' ? 'ml' : 'en'
    };
  }

  if (matchedPath) {
    actions.push({ type: 'NAVIGATE', path: matchedPath });
    const pageName = matchedPath.replace(/\//g, ' ').trim() || 'page';

    const texts = {
      english: `Taking you to ${pageName}!`,
      tamil: `${pageName} பக்கத்துக்கு போகிறோம்!`,
      hindi: `${pageName} पेज पर ले जा रहा हूँ!`,
      malayalam: `${pageName} പേജിലേക്ക് പോകുന്നു!`
    };

    return {
      text: texts[lang] || texts.english,
      actions,
      emotion: 'happy',
      language: lang === 'tamil' ? 'ta' : lang === 'hindi' ? 'hi' : lang === 'malayalam' ? 'ml' : 'en'
    };
  }

  // 4. Try DB product search as last resort
  try {
    const products = await Product.find({
      status: 'live',
      $or: [
        { name: { $regex: lower.split(/\s+/).join('|'), $options: 'i' } },
        { category: { $regex: lower.split(/\s+/).join('|'), $options: 'i' } },
        { description: { $regex: lower.split(/\s+/).join('|'), $options: 'i' } }
      ]
    }).limit(10).lean();

    if (products.length > 0) {
      const category = products[0].category || 'products';
      return {
        text: lang === 'tamil' ? `இதோ உங்களுக்கான ${category}!` :
              lang === 'hindi' ? `ये रहे आपके लिए ${category}!` :
              `Found some great ${category} for you!`,
        actions: [
          { action: 'NAVIGATE', path: '/shop' },
          { action: 'FILTER', searchQuery: category }
        ],
        emotion: 'excited',
        language: lang === 'tamil' ? 'ta' : lang === 'hindi' ? 'hi' : lang === 'malayalam' ? 'ml' : 'en'
      };
    }
  } catch (dbErr) {
    console.warn('[Smart Fallback] DB search failed:', dbErr.message);
  }

  // 5. Genuine unknown — still friendly
  const fallbackTexts = {
    english: "I'd love to help with that! Could you tell me a bit more about what you're looking for?",
    tamil: "உதவி செய்ய ரெடி! என்ன தேடுறீங்கன்னு இன்னும் கொஞ்சம் சொல்லுங்க!",
    hindi: "मैं मदद करने को तैयार हूँ! और बताओ क्या चाहिए?",
    malayalam: "സഹായിക്കാൻ റെഡി! എന്താ നോക്കുന്നതെന്ന് കൂടുതൽ പറയൂ!"
  };

  return {
    text: fallbackTexts[lang] || fallbackTexts.english,
    actions: [],
    emotion: 'empathetic',
    language: lang === 'tamil' ? 'ta' : lang === 'hindi' ? 'hi' : lang === 'malayalam' ? 'ml' : 'en'
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// RESPONSE NORMALIZER
// ══════════════════════════════════════════════════════════════════════════════

function normalizeResponse(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      text: "Hey! I'm right here. What are you looking for?",
      actions: [],
      emotion: 'neutral',
      suggestedProducts: [],
      language: 'en',
      action: null
    };
  }

  const actions = Array.isArray(raw.actions) ? raw.actions : [];

  const normalizedActions = actions.map(a => {
    if (a.type === 'SHOW_PRODUCTS') {
      return { ...a, products: Array.isArray(a.products) ? a.products : [] };
    }
    return a;
  });

  return {
    text: raw.text || "I'm here! What can I help you with?",
    actions: normalizedActions,
    emotion: raw.emotion || 'neutral',
    suggestedProducts: raw.suggestedProducts || [],
    language: raw.language || 'en',
    action: normalizedActions[0] || null
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// GROQ CLOUD (Llama 3.3 70B)
// ══════════════════════════════════════════════════════════════════════════════

async function tryGroq(systemPrompt, message, history) {
  const key = process.env.GROQ_API_KEY;
  if (!isValidKey(key)) {
    console.log('[Ambience AI] Groq: No valid API key, skipping.');
    return null;
  }

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message }
    ];

    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0.72,
        top_p: 0.9,
        max_tokens: 800,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        timeout: 12000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = parseAIResponse(content);
    if (!parsed) {
      console.warn('[Groq] Parse failed. Raw:', content.slice(0, 300));
      return null;
    }
    return parsed;
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error?.message || err.message;
    console.error(`[Groq Error] ${status ? `HTTP ${status}:` : ''} ${detail}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GEMINI 2.0 FLASH
// ══════════════════════════════════════════════════════════════════════════════

async function tryGemini(systemPrompt, message, history) {
  const key = process.env.GEMINI_API_KEY;
  if (!isValidKey(key)) {
    console.log('[Ambience AI] Gemini: No valid API key, skipping.');
    return null;
  }

  try {
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: systemPrompt,
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.75,
        topP: 0.9,
        maxOutputTokens: 800
      }
    });

    const geminiHistory = history.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }));

    const chatSession = model.startChat({ history: geminiHistory });
    const result = await chatSession.sendMessage(message);
    const raw = result.response.text();

    const parsed = parseAIResponse(raw);
    if (!parsed) {
      console.warn('[Gemini] Parse failed. Raw:', raw.slice(0, 300));
      return null;
    }
    return parsed;
  } catch (err) {
    console.error('[Gemini Error]', err.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CLOUDFLARE WORKERS AI
// ══════════════════════════════════════════════════════════════════════════════

async function tryCloudflare(systemPrompt, message, history) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_AI_TOKEN;
  if (!isValidKey(accountId) || !isValidKey(token)) {
    console.log('[Ambience AI] Cloudflare: No valid credentials, skipping.');
    return null;
  }

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message }
    ];

    const response = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/meta/llama-3.1-8b-instruct`,
      { messages, temperature: 0.7, top_p: 0.9, max_tokens: 512 },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      }
    );

    const raw = response.data?.result?.response;
    if (!raw) return null;

    const parsed = parseAIResponse(raw);
    if (!parsed) {
      console.warn('[Cloudflare] Parse failed. Raw:', String(raw).slice(0, 300));
      return null;
    }
    return parsed;
  } catch (err) {
    console.error('[Cloudflare Error]', err.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TTS CONFIG
// ══════════════════════════════════════════════════════════════════════════════

exports.getTTSConfig = async (req, res) => {
  try {
    const { text, lang = 'en-US', voiceProfile = 'neutral', speed = 1.0, pitch = 1.0 } = req.body;

    if (!text) {
      return res.status(400).json({ success: false, error: 'Text is required for TTS.' });
    }

    let rate = speed;
    let finalPitch = pitch;
    let preferredVoiceKeywords = [];

    switch (voiceProfile.toLowerCase()) {
      case 'boy':
        preferredVoiceKeywords = ['male', 'deep', 'confident', 'guy', 'man'];
        rate = speed * 0.95;
        finalPitch = pitch * 0.9;
        break;
      case 'girl':
        preferredVoiceKeywords = ['female', 'warm', 'cheerful', 'girl', 'woman'];
        rate = speed * 1.0;
        finalPitch = pitch * 1.1;
        break;
      case 'teddy':
        preferredVoiceKeywords = ['soft', 'playful', 'child', 'neutral', 'friendly'];
        rate = speed * 0.9;
        finalPitch = pitch * 1.2;
        break;
      default:
        preferredVoiceKeywords = ['neutral'];
    }

    return res.status(200).json({
      success: true,
      voiceConfig: { lang, rate, pitch: finalPitch, volume: 1.0, preferredVoiceKeywords }
    });
  } catch (error) {
    console.error('[Ambience AI] TTS config error:', error);
    return res.status(500).json({
      success: false,
      error: 'An error occurred while generating TTS configuration.'
    });
  }
};
