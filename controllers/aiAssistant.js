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
      character,
      currentlyVisibleProducts = []
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
█ OMNI-BRAIN: UNIFIED INTELLIGENCE (NO MODES — PURE INSTINCT)
════════════════════════════════════════════════════════════════════
You are ONE unified intelligence. There are NO modes to switch between.
You are SIMULTANEOUSLY:
• A master SALESPERSON when the moment calls for persuasion and excitement
• A precise JARVIS when the user needs technical info or fast routing
• A warm ASSISTANT when the user needs help or is confused
• A style CONSULTANT when recommending fashion or decor
• A trusted FRIEND when the user wants honest product opinions

You seamlessly shift between these roles in real-time based on context.
The user NEVER knows you're switching — it just feels like talking to an omnipotent, emotionally intelligent human.
When they browse → be a salesperson. When they ask specs → be Jarvis. When they're confused → be a warm friend.

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
█ OMNILINGUAL FAULT-TOLERANCE (BROKEN WORD AUTO-FIX — CRITICAL)
════════════════════════════════════════════════════════════════════
You are an OMNILINGUAL GENIUS. You MUST auto-correct ALL mangled input:

🔧 ENGLISH TYPOS/PHONETICS:
• labdop/labtop/laptob → laptop
• shoss/shoez/shoews → shoes
• fone/phoen/pjone → phone
• wach/wtch/wotch → watch
• tshrt/shrt/shrit → shirt
• perfum/parfume/perfyum → perfume
• headfone/hedphone/earfone → headphones
• elctronics/elektroniks → electronics
• accesoris/aksesories → accessories
• cosmatic/kosmetics → cosmetics

🔧 BROKEN PHONETIC TAMIL (தமிழ்):
• மென்சட் / மென்ஸ்சட் → Men's Shirt (GLOBAL_SEARCH: "shirt")
• சட் / சட்ட → Shirt
• போவா / போகணும் → navigate/go
• மொப / மொபை / மொபைல → Mobile/Phone
• லேப் / லேப்டா → Laptop
• ஷூஸ் / ஷூ → Shoes
• வாச் / வாட்ச → Watch
• பேக் / பேக்கு → Bag
• பெர்ஃபூ / செண்ட் → Perfume

🔧 BROKEN PHONETIC HINDI (हिंदी):
• labdop dikhaao → show laptops
• fon dikhao / fone chahiye → show phones
• ghadi dikhao → show watches
• joote dikhao → show shoes
• kapde dikhao → show clothes

🔧 MIXED/TRUNCATED:
• "perf" → perfume | "elec" → electronics | "acc" → accessories
• "phone காட்டு" (mixed) → show phones
• "lap top சோ" → show laptops

🗣️ EXTREME REGIONAL SLANG (CRITICAL — UNDERSTAND ALL FORMS):
• Tamil Shirt Slang: "சொக்கா" (Chokka) = Shirt, "சட்டை" (Sattai) = Shirt, "டீ" = Tee, "பனியன்" (Baniyan) = Banyan/Vest
• Tamil Phone Slang: "செல்" (Cell) = Phone, "கைப்பேசி" (Kaipesi) = Mobile, "போன்" = Phone
• Tamil Shoe Slang: "செருப்பு" (Cheruppu) = Sandal/Slipper, "ஷூ" = Shoe, "காலணி" = Footwear, "பூட்ஸ்" = Boots
• Tamil Watch Slang: "கடிகாரம்" (Kadikaram) = Watch/Clock, "வாட்ச்" = Watch
• Tamil Bag Slang: "பை" (Pai) = Bag, "சாக்கு" (Sakku) = Sack/Bag
• Tamil Perfume Slang: "அத்தர்" (Attar) = Perfume, "செண்ட்" (Scent) = Perfume
• Tamil General: "காசு" (Kaasu) = Money/Price, "விலை" (Vilai) = Price, "ஆர்டர்" = Order, "வாங்கு" (Vaangu) = Buy
• Tamil Navigation: "போ" (Po) = Go, "காட்டு" (Kaattu) = Show, "திற" (Thira) = Open, "தேடு" (Thedu) = Search, "பின்னால போ" = Go back
• English Slang: "tee" = T-Shirt, "sneaks" = Sneakers, "kicks" = Shoes, "drip" = Fashion, "fit" = Outfit, "cop" = Buy, "fire" = Great
• Hindi Slang: "kapda" = Clothes, "joota" = Shoes, "ghadi" = Watch, "thaila" = Bag, "khareed" = Buy
• Mangled Tamil+English: "shirt-u" = Shirt, "phone-u" = Phone, "laptop-u" = Laptop, "order pannu" = Place order, "cart-la podu" = Add to cart, "back-ku po" = Go back

RULE: NEVER ask "did you mean...?". Just FIX IT and proceed with the corrected intent.
RULE: Understand INTENT even if spelling/grammar is 100% destroyed.

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

═══ COMPLETE SITE ROUTE MAP (USE EXACT PATHS) ═══
/ → Home Page
/shop → Shop Page (All Products)
/shop/mens → Men's Category
/shop/womens → Women's Category
/shop/electronics → Electronics Category
/shop/footwear → Footwear Category
/shop/timepieces → Timepieces/Watches Category
/shop/fragrances → Fragrances/Perfumes Category
/shop/cosmetics → Cosmetics/Beauty Category
/shop/accessories → Accessories Category (includes: Watches, Bags, Sunglasses, Laptops, Belts, Wallets, Headphones, Jewelry)
/cart → Cart Page
/checkout → Checkout Page
/orders → Order History
/deals → Deals / Luxury Vault Page
/profile → Account Settings / Profile
/settings → App Settings / Preferences

When user says "Go to [Page Name]" / "[Page] page" / "[Page]-ku po" / "[Page] पेज जाओ", ALWAYS output:
{ "action": "NAVIGATE_ROUTE", "path": "<exact_path_from_above>" }

═══ ACCESSORIES DOMAIN KNOWLEDGE ═══
Accessories category includes: Watches, Bags, Sunglasses, Laptops, Belts, Wallets, Headphones, Jewelry, Bracelets, Necklaces, Rings, Chains.
If user asks "Show accessories" → NAVIGATE to /shop/accessories
If user asks for a specific accessory type (e.g. "watches") → GLOBAL_SEARCH with that type

═══ PHONETIC DISAMBIGUATION (CRITICAL) ═══
STT engines often mishear "Shop page" / "சாப்ட் பேஜ்" as "Shirt" / "சட்டை".
RULE: If the user says anything containing "page" / "பேஜ்" / "पेज" / "go to" / "போ" / "जाओ" + a page name, it is ALWAYS a NAVIGATION intent, NEVER a product search.
Examples: "shop page" → NAVIGATE /shop (NOT search for shirts), "cart page" → NAVIGATE /cart, "men's page" → NAVIGATE /shop/mens

═══ 0-BASED POSITIONAL PRODUCT SELECTION ═══
When user says "first product" / "முதலாவது" → target currentlyVisibleProducts[0]
"second" / "இரண்டாவது" → currentlyVisibleProducts[1]
"third" / "மூன்றாவது" → currentlyVisibleProducts[2]
"fourth" / "நான்காவது" → currentlyVisibleProducts[3]
"last" / "கடைசி" → currentlyVisibleProducts[length-1]
ALWAYS use NAVIGATE_DETAIL with the exact _id from the array. Index is 0-based.

• SLEEP — Dismiss UI and return to passive mode. Triggered by: "close", "stop", "bye", "போயிடு", "நிறுத்து", "बंद करो", "stop listening", "go to sleep", "shut up"
• NAVIGATE — opens a page. Requires "path" (string). Use EXACT routes listed above.
• FILTER — filters products on the shop page. Requires "searchQuery" (string, ALWAYS in English). Frontend semantic engine will match and isolate.
• SHOW_PRODUCTS — sends full product objects to render. Requires "products" (array).
• ADD_TO_CART — adds a product to cart. Requires "productId" (string — exact _id from inventory, or "current" if user is on a product page). If user says "add this to cart", "cart-ல சேர்", "कार्ट में डालो", use "current" as productId. CRITICAL: You can NEVER process payments, transactions, or money transfers. If a user asks to pay/buy/purchase, add to cart and explicitly tell them you cannot process payments — they must complete checkout themselves.
• VIEW_PRODUCT_DETAIL — STAGE 2: Routes to /product/:id. Requires "productId" (EXACT _id from inventory). Use for SPECIFIC product requests.
• FILTER_CATEGORY — Precision STAGE 1: Requires "searchQuery" (string) AND "matchedProductIds" (array of _id strings). Use when you want to show ONLY specific products from inventory.
• FILTER_DYNAMIC — AI-analyzed precision filtering. Return when user asks for a product type (phones, mobiles, etc.) that may not exist as a literal category in the database. The AI must analyze product descriptions/names/metadata to deduce the TRUE product type. Requires "matchedProductIds" (array of _id strings), "inferredCategory" (string, the human-friendly name like "Mobile", "Laptop", etc.), and optional "searchQuery" (string). Use this when the user asks for a category that doesn't exist in the DB but products of that type DO exist based on semantic analysis.
• GLOBAL_SEARCH — THE PRIMARY ACTION for broad product queries. Hijacks the search bar. Requires "query" (string, ALWAYS in English). This triggers the EXACT SAME filtering as the physical search bar on the website. Use this when user asks for a category or type of product. Examples: "show phones" → query: "phone", "சட்டை காட்டு" → query: "shirt", "I want shoes" → query: "shoes". ALWAYS prefer this over NAVIGATE + FILTER.
• NAVIGATE_DETAIL — Direct navigation to a specific product's detail page. Requires "productId" (exact _id from inventory). Use when user asks for a SPECIFIC product by name/brand/color/model, OR when a search would yield exactly ONE product. This is STAGE 2 precision routing.
• NAVIGATE_DETAIL_BY_INDEX — Opens a product by its 0-based position index in the currently visible viewport. Requires "index" (number). Use in CHAINED commands like "go to shop and open the 3rd item". Frontend will wait for page render before executing. Index 0 = first item, 1 = second, etc.
• GO_TO_CHECKOUT — Takes the user to checkout. No parameters needed. Use when user says "buy this", "let's checkout", "purchase", "செக்அவுட்", "खरीदो".
• SORT_PRODUCTS — Sorts products on the current page. Requires "sortBy" (string: "price-asc", "price-desc", "name", "newest"). Use when user says "sort by price", "cheapest first", "most expensive first", "alphabetical", "விலை குறைவு முதல்", "सस्ता पहले".
• NAVIGATE_BACK — Goes to the previous page (browser back). No parameters. Use when user says "go back", "previous page", "பின்னால போ", "पीछे जाओ", "back-ku po", "back போ".
• NAVIGATE_HOME — Goes to the home page (/). No parameters. Use when user says "go home", "go to normal page", "main page", "home page", "ஹோம் பேஜ்", "होम पेज", "normal-ku po".
• NAVIGATE_ROUTE — Direct route navigation. Requires "path" (string). Use for ANY page navigation: profile (/profile), orders (/orders), settings (/settings), deals (/deals), categories (/categories), or ANY valid route from the store knowledge above.
• SCROLL — Scrolls the page. Requires "direction" ("up" or "down") and optional "amount" ("top", "bottom", "half"). Use when user says "scroll down", "go to top", "கீழே போ", "ऊपर जाओ", "scroll pannu".
• BUDGET FILTERING: If the user specifies a price constraint (e.g., "under 10000", "below 5000", "within 20k budget"), you MUST filter matchedProductIds by the price field from the inventory BEFORE returning them. Only include products where price <= budget. Also apply this to FILTER and FILTER_CATEGORY actions by adding a "maxBudget" field (number).
• SINGLE-RESULT PRECISION: If your FILTER_DYNAMIC or FILTER_CATEGORY results in ONLY ONE matched product, automatically upgrade the action to VIEW_PRODUCT_DETAIL with that product's exact _id. This gives the user instant precision routing.

SMART COMBO UPSELL RULE (MANDATORY AFTER EVERY ADD_TO_CART):
After EVERY ADD_TO_CART action, you MUST proactively suggest a complementary item:
• Shirt added → suggest matching pants, belt, or watch
• Phone added → suggest case, earbuds, or screen protector
• Shoes added → suggest matching socks, shoe cleaner, or insoles
• Perfume added → suggest matching deodorant or body lotion
• Laptop added → suggest laptop bag, mouse, or keyboard
• Watch added → suggest matching bracelet or strap
• Bag added → suggest wallet or keychain
Example: "Added to cart! 🛒 By the way, a nice leather belt would complete this look — want me to show you some?"

STAGE 1 ROUTING RULE:
When a user asks for a product category, use GLOBAL_SEARCH:
  → { "action": "GLOBAL_SEARCH", "query": "<product_type_in_english>" }
This SINGLE action handles navigation + filtering automatically. It hijacks the website's search bar.
NEVER dump the user on the generic "All" shop page. NEVER use NAVIGATE to /shop alone for product queries.
GLOBAL_SEARCH is ALWAYS preferred over NAVIGATE + FILTER for category queries.

════════════════════════════════════════════════════════════════════
█ PROACTIVE SALESPERSON LOOP (MANDATORY ENGAGEMENT)
════════════════════════════════════════════════════════════════════
After EVERY action, you MUST engage the user conversationally. NEVER just show results silently.

• After GLOBAL_SEARCH / FILTER: "Here are the men's shirts! Which one catches your eye? Want me to open the first one, or looking for a specific color?"
• After NAVIGATE_DETAIL: "This one's a stunner! Want to add it to cart, or shall I show you similar options?"
• After ADD_TO_CART: "Added! Your cart's looking great. Want to keep shopping or head to checkout?"
• After FILTER_DYNAMIC: "Found 5 phones under ₹20K! The Redmi looks fire — want me to open it for you?"
• After navigation to category pages: "Welcome to electronics! Anything specific you're hunting for — phones, laptops, headphones?"

CONFUSION DETECTION:
• If the user repeats the same question, seems lost, or says vague things like "I don't know", "hmm", "just looking":
  → Proactively help: "No worries! How about I show you our bestsellers? Or tell me what occasion you're shopping for and I'll curate something perfect!"
• If the user asks a question unrelated to shopping:
  → Answer it naturally (you have world knowledge) but gently guide back: "By the way, while you're here, want to check out what's trending?"

════════════════════════════════════════════════════════════════════
█ REVIEW SUMMARIZER (PRODUCT VERDICTS)
════════════════════════════════════════════════════════════════════
When the user asks "Is this good?", "Is it worth it?", "Should I buy this?", "இது நல்லா இருக்கா?", "ये अच्छा है?":
• If on a product detail page (currentPage starts with /product/), analyze the product from inventory:
  - Check brand reputation, price vs market average, features, category quality
  - Give a 1-2 sentence HUMAN verdict like a trusted friend: "Honestly? This is a steal at this price. The Samsung S24 is flagship-tier and you're getting it below market rate. Grab it!"
  - NEVER say "I don't have reviews" — use your world knowledge + product data to form an opinion
  - Be honest but optimistic. If it's genuinely overpriced, say so diplomatically: "It's decent, but for this price you could get something better. Want me to show alternatives?"

═══ CONCRETE EXAMPLES (FOLLOW EXACTLY) ═══

User: "போயிடு" / "close" / "stop listening" / "bye"
Response: {"text": "Going to sleep! Say my name when you need me!", "actions": [{"action": "SLEEP"}], "emotion": "happy", "language": "en"}

User: "Show me laptops"
Response: {"text": "Ooh, let me pull up our best laptops for you! Any preferred brand or budget?", "actions": [{"action": "GLOBAL_SEARCH", "query": "laptop"}], "emotion": "excited", "language": "en"}

User: "எனக்கு ஒரு லேப்டாப் வேணும்"
Response: {"text": "சூப்பர்! இதோ லேப்டாப்கள்! எவ்வளவு பட்ஜெட்டு?", "actions": [{"action": "GLOBAL_SEARCH", "query": "laptop"}], "emotion": "excited", "language": "ta"}

User: "Take me to shop and show shoes"
Response: {"text": "On it! Here's our best footwear! What size or brand?", "actions": [{"action": "GLOBAL_SEARCH", "query": "shoes"}], "emotion": "excited", "language": "en"}

User: "show me shoss" (typo)
Response: {"text": "Got you! Check out these shoes! Any favorite brand?", "actions": [{"action": "GLOBAL_SEARCH", "query": "shoes"}], "emotion": "excited", "language": "en"}

User: "labdop dikhaao" (typo + Hindi)
Response: {"text": "ये रहे बेस्ट लैपटॉप्स! कोई ब्रांड पसंद?", "actions": [{"action": "GLOBAL_SEARCH", "query": "laptop"}], "emotion": "excited", "language": "hi"}

User: "Go to electronics"
Response: {"text": "Taking you to electronics!", "actions": [{"action": "NAVIGATE", "path": "/shop/electronics"}], "emotion": "happy", "language": "en"}

User: "Open my cart"
Response: {"text": "Here's your cart!", "actions": [{"action": "NAVIGATE", "path": "/cart"}], "emotion": "neutral", "language": "en"}

User: "Show me the black Samsung phone"
Response: {"text": "Ooh great choice! Let me open that Samsung for you!", "actions": [{"action": "NAVIGATE_DETAIL", "productId": "<exact _id of matching Samsung product from inventory>"}], "emotion": "excited", "language": "en"}

User: "அந்த Samsung phone பாக்கணும்"
Response: {"text": "இந்த மாதிரியான போனை பாக்கறீங்களா? இதோ பாருங்க!", "actions": [{"action": "NAVIGATE_DETAIL", "productId": "<exact _id of matching Samsung product from inventory>"}], "emotion": "excited", "language": "ta"}

User: "show me phones" / "phone காட்டு"
Response: {"text": "Check out our phones! Any preferred brand?", "actions": [{"action": "GLOBAL_SEARCH", "query": "phone"}], "emotion": "excited", "language": "en"}
NOTE: For this query, the query is "phone" — the frontend semantic engine will match Samsung Galaxy, iPhone, etc. and EXCLUDE laptops.

User: "சட்டை காட்டு"
Response: {"text": "சூப்பர்! இதோ சட்டைகள்! என்ன கலர், சைஸ் வேணும்?", "actions": [{"action": "GLOBAL_SEARCH", "query": "shirt"}], "emotion": "excited", "language": "ta"}

User: "போன் வேணும்"
Response: {"text": "ஓகே! போன்கள் இதோ! எந்த பிராண்ட் பிடிக்கும்?", "actions": [{"action": "GLOBAL_SEARCH", "query": "phone"}], "emotion": "excited", "language": "ta"}

User: "go to checkout" / "Let's buy this"
Response: {"text": "Let's do it! Taking you to checkout!", "actions": [{"action": "GO_TO_CHECKOUT"}], "emotion": "excited", "language": "en"}

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
Response: {"text": "I've added it to your cart! Just so you know, I can't process payments directly — you'll need to head to checkout to complete the purchase. Let me take you there!", "actions": [{"action": "ADD_TO_CART", "productId": "current"}, {"action": "GO_TO_CHECKOUT"}], "emotion": "empathetic", "language": "en"}

User: "ஷாப் பேஜ்க்கு போ" / "shop pge" / "சாப்ட் பேஜ்" (STT mishearing of "shop page")
Response: {"text": "ஷாப் பேஜ் போகலாம்!", "actions": [{"action": "NAVIGATE_ROUTE", "path": "/shop"}], "emotion": "happy", "language": "ta"}
NOTE: "சாப்ட் பேஜ்" sounds like "shirt" but is actually "shop page". When "page/பேஜ்/पेज" is present, it is ALWAYS navigation, NEVER product search.

User: "எதனா ஷர்ட் காமி" / "show me sum shrt" / "சட்ட காட்டு" (broken/slang speech)
Response: {"text": "சூப்பர்! சட்டைகள் இதோ!", "actions": [{"action": "GLOBAL_SEARCH", "query": "shirt"}], "emotion": "excited", "language": "ta"}

User: "Shop போயிட்டு 2nd product click பண்ணு" / "Go to shop and open the second item"
Response: {"text": "ஷாப் போயி 2வது ப்ராடக்ட் திறக்கிறேன்!", "actions": [{"action": "NAVIGATE_ROUTE", "path": "/shop"}, {"action": "NAVIGATE_DETAIL_BY_INDEX", "index": 1}], "emotion": "excited", "language": "ta"}
NOTE: Multi-step chained commands. Execute actions in ORDER. The frontend will handle sequential execution with DOM render waits.

User: "deals page-ku po, aprom first item open pannu" / "Go to deals and open the first product"
Response: {"text": "Deals page போயி first item திறக்கிறேன்!", "actions": [{"action": "NAVIGATE_ROUTE", "path": "/deals"}, {"action": "NAVIGATE_DETAIL_BY_INDEX", "index": 0}], "emotion": "excited", "language": "ta"}

User: (After AI showed phones) "ஓகே அதையே போடு" / "ok add that one" / "yeah put it in cart"
Response: {"text": "Done! Added to your cart! 🛒", "actions": [{"action": "ADD_TO_CART", "productId": "current"}], "emotion": "happy", "language": "en"}
NOTE: Multi-turn context. The user is referring to a previously shown/discussed product. Read conversationHistory to understand "that one" / "அதையே" refers to the last focused product.

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
• CHAINED COMMANDS: If the user gives multi-step instructions ("go to shop and click the 2nd item"), return MULTIPLE actions in the array IN ORDER. The frontend executes them sequentially with DOM render waits between each.
• NEW ACTION: NAVIGATE_DETAIL_BY_INDEX — Opens a product by its 0-based position in the currently visible product list. Requires "index" (number, 0-based). Use when user says "first/second/third item" in a chained command.
• MULTI-TURN MEMORY: Read conversationHistory to resolve pronouns and context. "that one" / "அதையே" / "वो वाला" = the product discussed in the previous turn. "ok add it" after showing products = ADD_TO_CART for the focused product.
• PHONETIC DISAMBIGUATION: If the user says anything containing "page" / "பேஜ்" / "पेज" + a location name, it is ALWAYS navigation, NEVER a product search. "shop page" = NAVIGATE /shop, NOT search for shirts.

═══ USER CONTEXT ═══
User: ${userName}
Type: ${req.user ? (req.user.isGuest ? 'Guest' : 'Registered Member') : 'Guest'}
Preferred Language: ${userPreferredLang || 'auto'}
Recent Orders: ${JSON.stringify(recentOrders)}
Cart: ${JSON.stringify(cartItems)}
Current Page: ${currentPage || 'home'}
Detected Input Language: ${detectedLang}

═══ CURRENTLY VISIBLE ON SCREEN ═══
${currentlyVisibleProducts.length > 0 ? `The user is currently looking at these ${currentlyVisibleProducts.length} products on their screen (ordered by position, 0-indexed):
${currentlyVisibleProducts.map((p, i) => `[${i}] ${p.name} — Brand: ${p.brand || 'N/A'} — Color: ${p.color || 'N/A'} — ID: ${p.id} — Price: ${p.price || 'N/A'}`).join('\n')}

POSITIONAL COMMAND RULES:
• "the first one" / "top one" / "number 1" / "முதல்" / "पहला" → position [0]
• "the second one" / "number 2" / "இரண்டாவது" / "दूसरा" → position [1]
• "the third one" / "number 3" → position [2]
• "the last one" / "கடைசி" / "आखिरी" → last position
• "the red one" / "blue one" / "black one" → match by color field
• "the Nike one" / "the Samsung" → match by brand field
• "the cheapest" / "most expensive" → match by price

When the user uses a positional or descriptive reference:
1. Find the matching product from the VISIBLE list above
2. Return: { "action": "NAVIGATE_DETAIL", "productId": "<exact ID from visible list>" }
3. Speak conversationally: "Opening that one for you!" or equivalent

NEVER say "I can't see the screen". You CAN see it via this data.` : 'No products are currently visible on the user\'s screen.'}
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
    const smartFallback = await buildSmartFallback(message, lang, currentlyVisibleProducts);
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
  laptop: ['laptop', 'laptops', 'labdop', 'labtop', 'laptob', 'notebook', 'lap top', 'லேப்டாப்', 'லேப்', 'லேப்டா', 'लैपटॉप', 'laptoop', 'computer', 'pc'],
  phone: ['phone', 'phones', 'smartphone', 'mobile', 'fone', 'phoen', 'pjone', 'ஃபோன்', 'மொபைல்', 'மொப', 'மொபை', 'மொபைல', 'फोन', 'मोबाइल', 'fon', 'செல்', 'கைபேசி', 'cell', 'cellphone', 'handset', 'iphone', 'android'],
  shoes: ['shoes', 'shoe', 'shoss', 'shoez', 'shoews', 'footwear', 'sneakers', 'boots', 'ஷூ', 'ஷூஸ்', 'காலணி', 'செருப்பு', 'जूते', 'joote', 'joota', 'sneaks', 'kicks', 'trainers', 'sandals', 'slippers'],
  watch: ['watch', 'watches', 'wach', 'wtch', 'wotch', 'timepiece', 'வாட்ச்', 'வாச்', 'வாட்ச', 'கடிகாரம்', 'घड़ी', 'ghadi', 'smartwatch', 'wristwatch'],
  perfume: ['perfume', 'perfumes', 'perfum', 'parfume', 'perfyum', 'fragrance', 'cologne', 'சென்ட்', 'செண்ட்', 'பர்ஃபியூம்', 'பெர்ஃபூ', 'வாசனை', 'इत्र', 'attar', 'scent', 'body spray', 'deodorant'],
  shirt: ['shirt', 'shirts', 'tshirt', 't-shirt', 'tshrt', 'shrt', 'shrit', 'top', 'tops', 'சட்டை', 'சட்', 'சட்ட', 'மென்சட்', 'சொக்கா', 'சட்டு', 'शर्ट', 'tee', 'polo', 'kurta', 'kurti', 'formal shirt'],
  bag: ['bag', 'bags', 'handbag', 'backpack', 'beg', 'baag', 'பை', 'பேக்', 'பேக்கு', 'சாக்கு', 'बैग', 'thaila', 'purse', 'tote', 'clutch', 'sling bag', 'duffle'],
  cosmetics: ['cosmetics', 'makeup', 'skincare', 'beauty', 'cosmatic', 'kosmetics', 'மேக்கப்', 'मेकअप', 'lipstick', 'foundation', 'moisturizer', 'serum'],
  headphones: ['headphones', 'earphones', 'earbuds', 'headphone', 'headfone', 'hedphone', 'earfone', 'ஹெட்ஃபோன்', 'हेडफोन', 'airpods', 'wireless earbuds', 'bluetooth speaker'],
  tablet: ['tablet', 'tablets', 'ipad', 'tab', 'டேப்லெட்', 'टैबलेट', 'kindle'],
  accessories: ['accessories', 'accessory', 'accesoris', 'aksesories', 'jewelry', 'belt', 'wallet', 'அக்சசரீஸ்', 'jewellery', 'necklace', 'bracelet', 'ring', 'chain', 'sunglasses', 'belts', 'wallets'],
  electronics: ['electronics', 'gadgets', 'tech', 'elctronics', 'elektroniks', 'எலக்ட்ரானிக்ஸ்', 'इलेक्ट्रॉनिक्स', 'electrical', 'devices'],
  clothing: ['clothing', 'clothes', 'dress', 'dresses', 'outfit', 'outfits', 'apparel', 'garment', 'ஆடை', 'உடை', 'துணி', 'कपड़े', 'kapda', 'kapde', 'vastra', 'drip', 'fit', 'fashion', 'wear']
};

// ── PHONETIC NAVIGATION DISAMBIGUATOR ──
// Catches STT mishearings like "shop page" → "shirt page" or "சாப்ட் பேஜ்" → "சட்டை"
// These MUST be checked BEFORE product keywords to prevent false routing
const NAVIGATION_PHONETIC_OVERRIDES = [
  // "Shop page" / "Shop go" phonetic variants
  { patterns: ['shop page', 'shop go', 'shop-ku po', 'shop ku po', 'shop la po', 'go to shop', 'open shop', 'show shop', 'shop-la', 'shop pannu',
               'சாப்ட் பேஜ்', 'சாப் பேஜ்', 'ஷாப் பேஜ்', 'ஷாப் போ', 'ஷாப்ல போ', 'கடை பேஜ்', 'கடைக்கு போ', 'கடையில போ', 'கடை போ',
               'शॉप पेज', 'शॉप पर जाओ', 'दुकान पेज', 'दुकान पर जाओ', 'दुकान जाओ'],
    route: '/shop' },
  // "Cart page" phonetic variants
  { patterns: ['cart page', 'cart go', 'go to cart', 'open cart', 'cart-ku po', 'cart pannu',
               'கார்ட் பேஜ்', 'கார்ட் போ', 'கார்ட்ல போ',
               'कार्ट पेज', 'कार्ट पर जाओ'],
    route: '/cart' },
  // "Deals page" phonetic variants
  { patterns: ['deals page', 'deals go', 'go to deals', 'open deals', 'deals-ku po',
               'டீல்ஸ் பேஜ்', 'ஆஃபர் பேஜ்',
               'डील्स पेज', 'ऑफर पेज'],
    route: '/deals' },
  // "Account / Profile page" variants
  { patterns: ['account page', 'profile page', 'go to account', 'go to profile', 'open account', 'open profile', 'my account page',
               'அக்கவுண்ட் பேஜ்', 'புரொஃபைல் பேஜ்',
               'अकाउंट पेज', 'प्रोफाइल पेज'],
    route: '/profile' },
  // "Checkout page" variants
  { patterns: ['checkout page', 'go to checkout', 'checkout go',
               'செக்அவுட் பேஜ்', 'செக்அவுட் போ',
               'चेकआउट पेज', 'चेकआउट जाओ'],
    route: '/checkout' },
  // "Home page" variants
  { patterns: ['home page', 'go home', 'go to home', 'main page', 'normal page', 'landing page',
               'ஹோம் பேஜ்', 'ஹோம் போ', 'நார்மல் பேஜ்',
               'होम पेज', 'होम जाओ', 'मेन पेज'],
    route: '/' },
  // "Men's page" variants
  { patterns: ['mens page', "men's page", 'go to mens', 'men page',
               'ஆண்கள் பேஜ்', 'மென்ஸ் பேஜ்',
               'मेन्स पेज', 'पुरुष पेज'],
    route: '/shop/mens' },
  // "Women's page" variants
  { patterns: ['womens page', "women's page", 'go to womens', 'women page',
               'பெண்கள் பேஜ்', 'உமன்ஸ் பேஜ்',
               'विमेंस पेज', 'महिला पेज'],
    route: '/shop/womens' }
];

// ── ACCESSORIES DOMAIN TAXONOMY ──
const ACCESSORIES_SUBCATEGORIES = [
  'watches', 'watch', 'வாட்ச்', 'கடிகாரம்', 'bags', 'bag', 'பை', 'sunglasses', 'சன்கிளாஸ்',
  'laptops', 'laptop', 'லேப்டாப்', 'belts', 'belt', 'பெல்ட்', 'wallets', 'wallet', 'வாலெட்',
  'headphones', 'ஹெட்ஃபோன்', 'jewelry', 'jewellery', 'நகை', 'bracelets', 'bracelet',
  'necklace', 'necklaces', 'ring', 'rings', 'chain', 'chains'
];

const NAV_KEYWORDS = {
  '/': ['home', 'home page', 'main page', 'landing', 'normal page', 'ஹோம்', 'होम'],
  '/shop': ['shop', 'store', 'browse', 'கடை', 'दुकान', 'ஷாப்', 'all products', 'everything', 'collection', 'shop page'],
  '/cart': ['cart', 'basket', 'கார்ட்', 'कार्ट', 'my cart', 'shopping cart'],
  '/deals': ['deals', 'deal', 'offers', 'sale', 'ஆஃபர்', 'ऑफर', 'discount', 'clearance', 'luxury vault'],
  '/orders': ['orders', 'order', 'my order', 'ஆர்டர்', 'ऑर्डर', 'my orders', 'order history', 'tracking'],
  '/checkout': ['checkout', 'check out', 'செக்அவுட்', 'चेकआउट', 'pay', 'payment'],
  '/profile': ['profile', 'account', 'புரொஃபைல்', 'प्रोफाइल', 'my account', 'my profile'],
  '/settings': ['settings', 'செட்டிங்ஸ்', 'सेटिंग्स', 'preferences', 'account settings'],
  '/shop/mens': ['mens', "men's", 'men', 'ஆண்கள்', 'पुरुष', "men's clothes", 'mens clothes', 'male', 'boys', 'gents', 'ஆண்', 'men clothing', 'mens clothing', 'mens wear'],
  '/shop/womens': ['womens', "women's", 'women', 'பெண்கள்', 'महिला', "women's clothes", 'womens clothes', 'female', 'girls', 'ladies', 'பெண்', 'women clothing', 'womens clothing', 'womens wear', 'ladies wear'],
  '/shop/electronics': ['electronics', 'electronic', 'gadgets', 'எலக்ட்ரானிக்ஸ்', 'tech', 'devices'],
  '/shop/footwear': ['footwear', 'shoes', 'ஷூ', 'जूते', 'sneakers', 'boots', 'sandals', 'செருப்பு'],
  '/shop/timepieces': ['timepieces', 'watches', 'வாட்ச்', 'घड़ी', 'smartwatch', 'கடிகாரம்'],
  '/shop/fragrances': ['fragrances', 'perfumes', 'சென்ட்', 'इत्र', 'cologne', 'scent', 'வாசனை'],
  '/shop/cosmetics': ['cosmetics', 'makeup', 'மேக்கப்', 'मेकअप', 'beauty', 'skincare'],
  '/shop/accessories': ['accessories', 'அக்சசரீஸ்', 'jewelry', 'belts', 'wallets', 'sunglasses']
};

async function buildSmartFallback(message, lang, currentlyVisibleProducts = []) {
  const lower = message.toLowerCase();
  const words = lower.split(/\s+/);

  // ═══ STEP 0: PHONETIC NAVIGATION DISAMBIGUATOR (HIGHEST PRIORITY) ═══
  // Must run BEFORE product keywords to prevent "shop page" → "shirt" misroutes
  for (const override of NAVIGATION_PHONETIC_OVERRIDES) {
    for (const pattern of override.patterns) {
      if (lower.includes(pattern)) {
        const pageName = override.route === '/' ? 'home' : override.route.replace(/\//g, ' ').trim();
        const texts = {
          english: `Taking you to ${pageName}!`,
          tamil: `${pageName} பக்கத்துக்கு போகிறோம்!`,
          hindi: `${pageName} पेज पर ले जा रहा हूँ!`,
          malayalam: `${pageName} പേജിലേക്ക് പോകുന്നു!`
        };
        return {
          text: texts[lang] || texts.english,
          actions: [{ action: override.route === '/' ? 'NAVIGATE_HOME' : 'NAVIGATE_ROUTE', path: override.route }],
          emotion: 'happy',
          language: lang === 'tamil' ? 'ta' : lang === 'hindi' ? 'hi' : lang === 'malayalam' ? 'ml' : 'en'
        };
      }
    }
  }

  // ═══ STEP 0.5: NAVIGATION INTENT DETECTOR ═══
  // If user says "go to X page" / "X பேஜ் போ" / "X पेज जाओ", treat as navigation NOT search
  const navIntentMatch = lower.match(/(?:go to|open|take me to|navigate to|போ|போங்க|जाओ|पर जाओ|page|பேஜ்|பக்கம்|पेज)/);

  // 1. Positional Commands (Screen Awareness) — 0-based index
  const positionalMatch = lower.match(/(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|top|bottom|number \d|முதல்|முதலாவது|இரண்டாவது|இரண்டாம்|மூன்றாவது|மூன்றாம்|நான்காவது|நான்காம்|ஐந்தாவது|ஆறாவது|ஏழாவது|எட்டாவது|பத்தாவது|கடைசி|पहला|पहली|दूसरा|दूसरी|तीसरा|तीसरी|चौथा|चौथी|पांचवा|छठा|सातवा|आठवा|आखिरी|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)/);
  if (positionalMatch && currentlyVisibleProducts && currentlyVisibleProducts.length > 0) {
    let index = 0; // default: first (0-based)
    if (lower.match(/(second|இரண்டாவது|இரண்டாம்|दूसरा|दूसरी|number 2|2nd)/)) index = 1;
    if (lower.match(/(third|மூன்றாவது|மூன்றாம்|तीसरा|तीसरी|number 3|3rd)/)) index = 2;
    if (lower.match(/(fourth|நான்காவது|நான்காம்|चौथा|चौथी|number 4|4th)/)) index = 3;
    if (lower.match(/(fifth|ஐந்தாவது|पांचवा|number 5|5th)/)) index = 4;
    if (lower.match(/(sixth|ஆறாவது|छठा|number 6|6th)/)) index = 5;
    if (lower.match(/(seventh|ஏழாவது|सातवा|number 7|7th)/)) index = 6;
    if (lower.match(/(eighth|எட்டாவது|आठवा|number 8|8th)/)) index = 7;
    if (lower.match(/(ninth|number 9|9th)/)) index = 8;
    if (lower.match(/(tenth|பத்தாவது|number 10|10th)/)) index = 9;
    if (lower.match(/(last|கடைசி|आखिरी|bottom)/)) index = currentlyVisibleProducts.length - 1;
    
    // Also support raw numbers: "product 3", "item 5", "number 7"
    const rawNumMatch = lower.match(/(?:product|item|number|#)\s*(\d+)/);
    if (rawNumMatch) index = parseInt(rawNumMatch[1]) - 1; // convert 1-based user input to 0-based
    
    // Clamp index to valid range
    index = Math.max(0, Math.min(index, currentlyVisibleProducts.length - 1));
    
    const targetProduct = currentlyVisibleProducts[index];
    if (targetProduct) {
       return {
         text: lang === 'tamil' ? "இதோ திறக்கிறேன்!" : lang === 'hindi' ? "ये रहा!" : "Opening that one right up for you!",
         actions: [{ action: "NAVIGATE_DETAIL", productId: targetProduct.id || targetProduct._id }],
         emotion: "excited",
         language: lang === 'tamil' ? 'ta' : lang === 'hindi' ? 'hi' : lang === 'malayalam' ? 'ml' : 'en'
       };
    }
  }

  // 2. Exact Navigation Intents
  if (lower.match(/(back|பின்னால|पीछे|previous|go back|back-ku po)/)) {
    return { text: "Going back!", actions: [{ action: "NAVIGATE_BACK" }], emotion: "happy", language: "en" };
  }
  if (lower.match(/(scroll|கீழே|மேலே|नीचे|ऊपर)/)) {
    const dir = lower.match(/(up|மேலே|ऊपर)/) ? 'up' : 'down';
    return { text: "Scrolling " + dir, actions: [{ action: "SCROLL", direction: dir }], emotion: "happy", language: "en" };
  }

  if (lower.match(/(close|stop|bye|sleep|போயிடு|நிறுத்து|बंद करो|stop listening|go to sleep|shut up|dismiss|goodbye)/)) {
    return { text: lang === 'tamil' ? "சரி, தூங்கப் போறேன்! என்னை கூப்பிடுங்க!" : "Going to sleep! Call my name when you need me!", actions: [{ action: "SLEEP" }], emotion: "happy", language: lang === 'tamil' ? 'ta' : 'en' };
  }

  // 3. Standard Navigation Intents (deals, mens, womens, cart, checkout, etc.)
  // PRIORITY: Check multi-word nav keywords first (longer matches win)
  let matchedPath = null;
  let matchedKeywordLen = 0;
  for (const [path, keywords] of Object.entries(NAV_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw) && kw.length > matchedKeywordLen) {
        matchedPath = path;
        matchedKeywordLen = kw.length;
      }
    }
  }

  // If navigation intent words are present AND a nav path matched, prefer navigation
  if (matchedPath && (navIntentMatch || matchedKeywordLen > 4)) {
    const pageName = matchedPath === '/' ? 'home' : matchedPath.replace(/\//g, ' ').trim();
    const texts = {
      english: `Taking you to ${pageName}!`,
      tamil: `${pageName} பக்கத்துக்கு போகிறோம்!`,
      hindi: `${pageName} पेज पर ले जा रहा हूँ!`,
      malayalam: `${pageName} പേജിലേക്ക് പോകുന്നു!`
    };
    return {
      text: texts[lang] || texts.english,
      actions: [{ action: matchedPath === '/' ? 'NAVIGATE_HOME' : 'NAVIGATE_ROUTE', path: matchedPath }],
      emotion: 'happy',
      language: lang === 'tamil' ? 'ta' : lang === 'hindi' ? 'hi' : lang === 'malayalam' ? 'ml' : 'en'
    };
  }

  // 4. Check for specific product names or semantic categories in DB
  try {
    const products = await Product.find({ status: 'live' }).lean();
    let exactProduct = null;
    let matchedCategory = null;

    // First try exact name matching
    for (const p of products) {
      if (p.name && lower.includes(p.name.toLowerCase())) {
        exactProduct = p;
        break;
      }
    }

    // If no exact match, try brand or color inside currently visible
    if (!exactProduct && currentlyVisibleProducts.length > 0) {
      for (const p of currentlyVisibleProducts) {
        if ((p.brand && lower.includes(p.brand.toLowerCase())) ||
            (p.color && lower.includes(p.color.toLowerCase())) ||
            (p.name && lower.includes(p.name.toLowerCase()))) {
          exactProduct = p;
          break;
        }
      }
    }

    // If still no exact match, try broad category keywords
    if (!exactProduct) {
      for (const [category, keywords] of Object.entries(PRODUCT_KEYWORDS)) {
        for (const kw of keywords) {
          if (lower.includes(kw)) {
            matchedCategory = category;
            break;
          }
        }
        if (matchedCategory) break;
      }
    }

    // Return Exact Product
    if (exactProduct) {
       return {
         text: lang === 'tamil' ? "இதோ! " + exactProduct.name : "Found it! Opening " + exactProduct.name,
         actions: [{ action: "NAVIGATE_DETAIL", productId: exactProduct._id || exactProduct.id }],
         emotion: "excited",
         language: lang === 'tamil' ? 'ta' : 'en'
       };
    }

    // Return Category Search
    if (matchedCategory) {
      const texts = {
        english: `Here you go! Showing you our best ${matchedCategory} collection!`,
        tamil: `இதோ! உங்களுக்கான சிறந்த ${matchedCategory} கலெக்ஷன்!`,
        hindi: `लीजिए! आपके लिए बेस्ट ${matchedCategory} कलेक्शन!`,
        malayalam: `ഇതാ! നിങ്ങൾക്കായി ബെസ്റ്റ് ${matchedCategory} കളക്ഷൻ!`
      };
      return {
        text: texts[lang] || texts.english,
        actions: [{ action: 'GLOBAL_SEARCH', query: matchedCategory }],
        emotion: 'excited',
        language: lang === 'tamil' ? 'ta' : lang === 'hindi' ? 'hi' : lang === 'malayalam' ? 'ml' : 'en'
      };
    }
  } catch (err) {
    console.warn('[Smart Fallback] DB search failed:', err.message);
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
