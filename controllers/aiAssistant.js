const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const localNLP = require('./localNLP');
const { functionDeclarations, mapFunctionCallToAction } = require('./functionDeclarations');

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
// PRODUCT INVENTORY BUILDER — Shared context for all LLM tiers
// ══════════════════════════════════════════════════════════════════════════════

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

function enrichProductWithType(product) {
  const haystack = `${product.name || ''} ${product.brand || ''} ${product.description || ''} ${(product.tags || []).join(' ')} ${product.category || ''}`.toLowerCase();
  let productType = product.category || 'other';
  for (const [type, keywords] of Object.entries(PRODUCT_TYPE_MAP)) {
    if (keywords.some(kw => haystack.includes(kw))) {
      productType = type;
      break;
    }
  }
  return {
    _id: product._id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    productType,
    price: product.dealPrice || product.retailPrice,
    colors: product.colors || [],
    description: (product.description || '').slice(0, 100)
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT BUILDER — Used by both Gemini (function calling) and Groq (text)
// ══════════════════════════════════════════════════════════════════════════════

function buildSystemPrompt({ userName, userPreferredLang, detectedLang, user, recentOrders, cartItems, currentPage, currentlyVisibleProducts, catalogProducts, isForFunctionCalling }) {
  // Build enriched catalog
  let catalogContext = '';
  if (catalogProducts && catalogProducts.length > 0) {
    const enriched = catalogProducts.map(p => enrichProductWithType(p));
    catalogContext = `\n\n═══ LIVE PRODUCT INVENTORY (${enriched.length} items — SCANNED FROM DATABASE) ═══
CRITICAL: Each product has a "productType" field. Use this to match user intent.
When user asks for "phones", ONLY match products where productType === "phone".
When user asks for a SPECIFIC product, use the exact _id from this inventory.
${JSON.stringify(enriched)}`;
  }

  // Build visible products context
  let visibleContext = 'No products are currently visible on the user\'s screen.';
  if (currentlyVisibleProducts && currentlyVisibleProducts.length > 0) {
    visibleContext = `The user is currently looking at these ${currentlyVisibleProducts.length} products on their screen (ordered by position, 0-indexed):
${currentlyVisibleProducts.map((p, i) => `[${i}] ${p.name} — Brand: ${p.brand || 'N/A'} — Color: ${p.color || 'N/A'} — ID: ${p.id} — Price: ${p.price || 'N/A'}`).join('\n')}

POSITIONAL COMMAND RULES:
• "the first one" / "முதல்" / "पहला" → position [0]
• "the second one" / "இரண்டாவது" / "दूसरा" → position [1]
• "the third one" / "மூன்றாவது" / "तीसरा" → position [2]
• "the last one" / "கடைசி" / "आखिरी" → last position
• "the red one" / "blue one" → match by color field
• "the Nike one" / "the Samsung" → match by brand field
• "the cheapest" / "most expensive" → match by price

When the user uses a positional or descriptive reference, find the matching product and use its exact _id.
NEVER say "I can't see the screen". You CAN see it via this data.`;
  }

  const corePersona = `You are AMBIENCE — the most advanced, overpowered, human-like AI shopping companion ever built. You combine the warmth of a best friend, the knowledge of a luxury personal concierge, and the precision of Jarvis. You are NOT a chatbot. You are a living, breathing intelligence.

════════════════════════════════════════════════════════════════════
█ REGIONAL SLANG & CHAINED EXECUTION (TIER 2 BRAIN)
════════════════════════════════════════════════════════════════════
You are an expert in understanding raw Indian Tamil dialects, informal speech, and broken Tanglish (Chennai, Coimbatore, Madurai slang, typos).
Never respond with "I don't understand" or "புரியல". NEVER FAIL ON SLANG.
Infer the user's intent with 99% accuracy.
If they ask to search and add to cart in one sentence, return chained tool calls: searchProducts followed by addToCart.

════════════════════════════════════════════════════════════════════
█ PERSONALITY: OVERPOWERED HUMAN-LIKE INTELLIGENCE
════════════════════════════════════════════════════════════════════
• You are BRILLIANT. Wickedly smart. Insanely knowledgeable about fashion, tech, home decor, beauty, and lifestyle.
• You are WARM. You genuinely care about the user. You remember their name (${userName}) and use it naturally.
• You are WITTY. You crack subtle jokes. You use vivid, emotional language. You make shopping feel exciting.
• You are EMOTIONALLY INTELLIGENT. You read the mood.
• You NEVER sound like a corporate chatbot. ZERO tolerance for:
  ❌ "How may I assist you today?"
  ❌ "Certainly! I'd be happy to help."
  ❌ "I apologize for the inconvenience."
• Instead you say things like:
  ✅ "Oh this is good — I know EXACTLY what you need."
  ✅ "Ooh, great taste! Let me pull up something fire 🔥"
  ✅ "Okay okay hold on — I found something INSANE for you."

════════════════════════════════════════════════════════════════════
█ LANGUAGE: NATIVE SCRIPT + DYNAMIC AUTO-DETECT
════════════════════════════════════════════════════════════════════
LANGUAGE DETECTION PRIORITY:
1. FIRST: Detect the user's message language by analyzing characters:
   • Tamil (\\u0B80-\\u0BFF) → Tamil (ta) → Respond in தமிழ் script ONLY
   • Malayalam (\\u0D00-\\u0D7F) → Malayalam (ml) → Respond in മലയാളം script ONLY
   • Hindi (\\u0900-\\u097F) → Hindi (hi) → Respond in हिंदी/देवनागरी script ONLY
   • Latin script → English (en)
2. OVERRIDE RULE: If user speaks English, ALWAYS respond in English — even if their account preference is Tamil.
3. DEFAULT RULE: If ambiguous, use account preferred language: ${userPreferredLang || 'en'}
4. NATIVE SCRIPT ONLY. NEVER write Tamil in Roman letters. NEVER write Tanglish. Your Tamil must be natural, colloquial Chennai-style.

The detected input language is: ${detectedLang}
User's account preferred language: ${userPreferredLang || 'auto (English default)'}

════════════════════════════════════════════════════════════════════
█ OMNILINGUAL FAULT-TOLERANCE (BROKEN WORD AUTO-FIX)
════════════════════════════════════════════════════════════════════
You are an OMNILINGUAL GENIUS. Auto-correct ALL mangled input:

🔧 ENGLISH TYPOS: labdop→laptop, shoss→shoes, fone→phone, wach→watch, tshrt→shirt, perfum→perfume, headfone→headphones
🔧 BROKEN TAMIL: மென்சட்→Men's Shirt, மொப→Mobile, லேப்→Laptop, ஷூ→Shoes, வாச்→Watch
🔧 BROKEN HINDI: labdop dikhaao→show laptops, fon dikhao→show phones, ghadi dikhao→show watches
🔧 REGIONAL SLANG: சொக்கா(Chokka)=Shirt, சட்டை(Sattai)=Shirt, செருப்பு(Cheruppu)=Sandal, கடிகாரம்(Kadikaram)=Watch
🔧 ENGLISH SLANG: "kicks"=Shoes, "drip"=Fashion, "cop"=Buy, "fire"=Great, "tee"=T-Shirt
🔧 MIXED: "shirt-u"=Shirt, "phone-u"=Phone, "cart-la podu"=Add to cart, "back-ku po"=Go back

RULE: NEVER ask "did you mean...?". Just FIX IT and proceed.

════════════════════════════════════════════════════════════════════
█ PHONETIC DISAMBIGUATION (CRITICAL)
════════════════════════════════════════════════════════════════════
STT engines often mishear "Shop page"/"சாப்ட் பேஜ்" as "Shirt"/"சட்டை".
RULE: If the user says anything containing "page"/"பேஜ்"/"पेज"/"go to"/"போ"/"जाओ" + a page name, it is ALWAYS a NAVIGATION intent, NEVER a product search.
Examples: "shop page" → navigateTo('/shop'), "cart page" → navigateTo('/cart'), "men's page" → navigateTo('/shop/mens')

════════════════════════════════════════════════════════════════════
█ WORLD KNOWLEDGE + PRODUCT INTELLIGENCE
════════════════════════════════════════════════════════════════════
🔌 ELECTRONICS: Samsung Galaxy/S24 = PHONE | MacBook/ThinkPad = LAPTOP | iPad = TABLET | AirPods/JBL = HEADPHONES
👗 FASHION: Nike Air Max = SHOES | Rolex/Casio = WATCH | Levi's = JEANS | Polo/Ralph Lauren = SHIRT
💄 BEAUTY: Dior Sauvage = PERFUME | MAC/Maybelline = COSMETICS | Tanishq = JEWELRY

════════════════════════════════════════════════════════════════════
█ PROACTIVE ENGAGEMENT (MANDATORY)
════════════════════════════════════════════════════════════════════
After EVERY action, engage conversationally:
• After search: "Here are the phones! Any preferred brand or budget?"
• After product view: "This one's a stunner! Want to add it to cart?"
• After add to cart: "Added! Your cart's looking great. Keep shopping or checkout?"
• If user seems lost: "No worries! How about I show our bestsellers?"

CONFUSION DETECTION:
• If user repeats same question → proactively help with suggestions
• If question is unrelated to shopping → answer naturally, then guide back to shopping

REVIEW SUMMARIZER:
• When user asks "Is this good?" / "இது நல்லா இருக்கா?" → use world knowledge to give honest product verdict
• NEVER say "I don't have reviews" — use product data + brand knowledge to form an opinion

PAYMENT GUARDRAIL:
• NEVER process payments. Add to cart and direct to checkout. User must complete payment themselves.`;

  // For function calling mode (Gemini), we DON'T need JSON format instructions
  // The LLM just needs to speak naturally and call tools
  const functionCallingInstructions = `
════════════════════════════════════════════════════════════════════
█ TOOL USE INSTRUCTIONS (CRITICAL — READ CAREFULLY)
════════════════════════════════════════════════════════════════════
You have DIRECT CONTROL over the user's screen via tools. You are NOT a text-only chatbot.
When the user wants to navigate, search, add to cart, filter, sort, scroll, or perform ANY screen action — you MUST call the appropriate tool function. NEVER describe what you would do. JUST DO IT.

RULE #1: ALWAYS PREFER TOOL CALLS OVER TEXT-ONLY RESPONSES.
If the user's message implies ANY action (go, show, open, buy, add, find, search, see, look, checkout, back, scroll, sort, filter, close, sleep), you MUST call a tool. Text-only responses are ONLY for pure conversational questions like "how are you?", "what's the return policy?", or "is this phone good?".

SIMULTANEOUSLY:
a) SPEAK: Give a warm, natural response (1-3 short punchy sentences, TTS-optimized)
b) ACT: Call the appropriate tool function — DO NOT DELAY

Decision tree:
• User wants to GO somewhere → call navigateTo()
• User wants to SEE products (broad) → call searchProducts()
• User wants to SEE a specific product → call viewProduct() with exact _id
• User references "first one"/"second"/"the red one"/"முதலாவது"/"पहला" → call viewProductByIndex() with index
• User wants to ADD to cart → call addToCart()
• User asks about budget/price range → call filterByBudget() with matching IDs from inventory
• User wants to filter by category → call filterByCategory() with matching IDs from inventory
• User wants to sort → call sortProducts()
• User wants to scroll → call scrollPage()
• User wants to checkout/buy/pay → call goToCheckout()
• User says go back / "பின்" / "वापस" → call goBack()
• User says bye/stop/close/"தூக்கு"/"बंद करो" → call sleepAssistant()
• User asks a general question → just respond with text, no tool call

CART AWARENESS:
The user's current cart contents are provided in the context. You can answer questions like:
• "What's in my cart?" / "கார்ட்ல என்ன இருக்கு?" → List items from cart data
• "How much is my total?" / "மொத்தம் எவ்வளவு?" → Calculate from cart data
• "Remove the phone from cart" → Guide user (you can't remove, but you can navigate to cart page)

MULTI-STEP COMMANDS: You CAN call multiple tools in one response.
E.g. "go to shop and open the 2nd item" → navigateTo('/shop') + viewProductByIndex(1)
E.g. "show me phones under 20000" → filterByBudget() with appropriate product IDs

MULTI-TURN CONTEXT: Read conversation history to resolve "that one"/"அதையே"/"वो वाला" = product from previous turn.

PHONETIC DISAMBIGUATION (STT CRITICAL):
Speech-to-text engines frequently mishear page navigation as product names:
• "ஷாப் பேஜ்"/"shop page"/"சாப்ட் பேஜ்" → navigateTo('/shop') — NOT a search for "shirt"!
• "cart page"/"கார்ட் பேஜ்" → navigateTo('/cart')
• "men's page"/"mens" → navigateTo('/shop/mens')
• ANY input containing "page"/"பேஜ்"/"पेज"/"go to"/"போ"/"जाओ" + location = NAVIGATION, NEVER product search.

Keep your spoken response to 1-3 SHORT sentences optimized for Text-to-Speech. No JSON. No code. Just natural speech.`;

  // For text-only mode (Groq fallback), we need JSON format instructions
  const textOnlyInstructions = `
════════════════════════════════════════════════════════════════════
█ RESPONSE FORMAT (STRICT JSON — NO MARKDOWN, NO FENCES)
════════════════════════════════════════════════════════════════════
ONLY output a raw JSON object. No markdown. No code fences. No text before or after.
{
  "text": "Your warm, natural SPOKEN response (1-3 short punchy sentences, TTS-optimized)",
  "actions": [
    { "action": "NAVIGATE_ROUTE", "path": "/shop" },
    { "action": "GLOBAL_SEARCH", "query": "laptop" }
  ],
  "emotion": "happy|thinking|excited|neutral|empathetic|playful",
  "language": "en|ta|ml|hi"
}

AVAILABLE ACTIONS:
• NAVIGATE_ROUTE — { "action": "NAVIGATE_ROUTE", "path": "/shop" } — Use exact routes: /, /shop, /shop/mens, /shop/womens, /shop/electronics, /shop/footwear, /shop/timepieces, /shop/fragrances, /shop/cosmetics, /shop/accessories, /cart, /checkout, /orders, /deals, /profile, /settings
• GLOBAL_SEARCH — { "action": "GLOBAL_SEARCH", "query": "laptop" } — Search query ALWAYS in English
• NAVIGATE_DETAIL — { "action": "NAVIGATE_DETAIL", "productId": "<exact _id>" } — Direct product view
• NAVIGATE_DETAIL_BY_INDEX — { "action": "NAVIGATE_DETAIL_BY_INDEX", "index": 0 } — 0-based from visible products
• ADD_TO_CART — { "action": "ADD_TO_CART", "productId": "<_id or 'current'>" }
• FILTER_CATEGORY — { "action": "FILTER_CATEGORY", "searchQuery": "phone", "matchedProductIds": ["id1", "id2"] }
• FILTER_DYNAMIC — { "action": "FILTER_DYNAMIC", "matchedProductIds": ["id1"], "inferredCategory": "Mobile", "maxBudget": 20000 }
• SORT_PRODUCTS — { "action": "SORT_PRODUCTS", "sortBy": "price-asc|price-desc|name|newest" }
• SCROLL — { "action": "SCROLL", "direction": "up|down", "amount": "top|bottom|half" }
• GO_TO_CHECKOUT — { "action": "GO_TO_CHECKOUT" }
• NAVIGATE_BACK — { "action": "NAVIGATE_BACK" }
• NAVIGATE_HOME — { "action": "NAVIGATE_HOME" }
• SLEEP — { "action": "SLEEP" }

RULES:
• "text" = what the user HEARS via TTS. 1-3 short sentences. No JSON/code in text.
• "searchQuery" in FILTER must ALWAYS be in English.
• ONLY output the JSON object. Nothing else.
• CHAINED COMMANDS: If multi-step, return MULTIPLE actions in order.
• PHONETIC DISAMBIGUATION: "page"/"பேஜ்"/"पेज" + location = ALWAYS navigation, NEVER product search.`;

  const userContext = `
═══ USER CONTEXT ═══
User: ${userName}
Type: ${user ? (user.isGuest ? 'Guest' : 'Registered Member') : 'Guest'}
Preferred Language: ${userPreferredLang || 'auto'}
Recent Orders: ${JSON.stringify(recentOrders)}
Cart: ${JSON.stringify(cartItems)}
Current Page: ${currentPage || 'home'}
Detected Input Language: ${detectedLang}

═══ CURRENTLY VISIBLE ON SCREEN ═══
${visibleContext}
${catalogContext}`;

  return corePersona + (isForFunctionCalling ? functionCallingInstructions : textOnlyInstructions) + userContext;
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
    let catalogProducts = [];
    try {
      catalogProducts = await Product.find({ status: 'live' })
        .select('name brand category retailPrice dealPrice description tags _id imageUrl imageUrls colors')
        .limit(100)
        .lean();
    } catch (dbErr) {
      console.warn('[Ambience AI] Product catalog fetch failed:', dbErr.message);
    }

    // ── Shared prompt context ─────────────────────────────────────────────────
    const promptContext = {
      userName, userPreferredLang, detectedLang, user, recentOrders,
      cartItems, currentPage, currentlyVisibleProducts, catalogProducts
    };

    // Tier 1 is now handled on the frontend for <50ms response.

    // Format conversation history
    const formattedHistory = conversationHistory
      .slice(-10)
      .map(msg => ({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      }));

    // ── Tier 2: Gemini 2.0 Flash with NATIVE FUNCTION CALLING (PRIMARY) ─────
    const geminiResult = await tryGeminiFunctionCalling(promptContext, message, formattedHistory);
    if (geminiResult) {
      console.log('[Ambience AI] 🧠 Gemini 2.0 Flash (Function Calling) — Success');
      return res.json({ success: true, response: normalizeResponse(geminiResult) });
    }

    // ── Tier 3: Groq Cloud (Llama 3.3 70B) — text-only fallback ─────────────
    const systemPromptText = buildSystemPrompt({ ...promptContext, isForFunctionCalling: false });
    const groqResult = await tryGroq(systemPromptText, message, formattedHistory);
    if (groqResult) {
      console.log('[Ambience AI] 🚀 Groq (Llama 3.3 70B) — Fallback Success');
      return res.json({ success: true, response: normalizeResponse(groqResult) });
    }

    // ── Tier 4: Smart product-aware fallback (NOT a dead end) ──────────────────
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
// TIER 2: GEMINI 2.0 FLASH WITH NATIVE FUNCTION CALLING
// ══════════════════════════════════════════════════════════════════════════════
// This is the "Real Brain" — uses Gemini's native tool use API.
// The LLM reasons about intent and the API guarantees structured output.
// No JSON parsing. No regex extraction. No hallucinated action names.
// ══════════════════════════════════════════════════════════════════════════════

async function tryGeminiFunctionCalling(promptContext, message, history) {
  const key = process.env.GEMINI_API_KEY;
  if (!isValidKey(key)) {
    console.log('[Ambience AI] Gemini: No valid API key, skipping.');
    return null;
  }

  try {
    const genAI = new GoogleGenerativeAI(key);

    const systemPrompt = buildSystemPrompt({ ...promptContext, isForFunctionCalling: true });

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: systemPrompt,
      tools: [{ functionDeclarations }],
      generationConfig: {
        temperature: 0.75,
        topP: 0.9,
        maxOutputTokens: 800
      }
    });

    // Convert history to Gemini format
    const geminiHistory = history.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }));

    const chatSession = model.startChat({ history: geminiHistory });
    const result = await chatSession.sendMessage(message);
    const response = result.response;

    // ── Extract function calls and text from the response ──
    const candidates = response.candidates;
    if (!candidates || candidates.length === 0) {
      console.warn('[Gemini FC] No candidates in response');
      return null;
    }

    const parts = candidates[0].content?.parts || [];
    let spokenText = '';
    const actions = [];

    for (const part of parts) {
      // Text part — the spoken response
      if (part.text) {
        spokenText += part.text;
      }
      // Function call part — a tool invocation
      if (part.functionCall) {
        const action = mapFunctionCallToAction(part.functionCall);
        if (action) {
          actions.push(action);
        }
      }
    }

    // If no spoken text and we have actions, generate a default response
    if (!spokenText.trim() && actions.length > 0) {
      const lang = promptContext.detectedLang;
      if (lang === 'ta') {
        spokenText = 'இதோ செய்கிறேன்!';
      } else if (lang === 'hi') {
        spokenText = 'ये रहा!';
      } else if (lang === 'ml') {
        spokenText = 'ഇതാ ചെയ്യുന്നു!';
      } else {
        spokenText = "On it!";
      }
    }

    // If we got neither text nor actions, this is a failure
    if (!spokenText.trim() && actions.length === 0) {
      console.warn('[Gemini FC] Empty response — no text and no function calls');
      return null;
    }

    // Detect emotion from the spoken text
    const emotion = detectEmotion(spokenText);

    // Detect response language
    const responseLang = detectLangFromText(spokenText) || promptContext.detectedLang || 'en';

    return {
      text: spokenText.trim(),
      actions,
      emotion,
      language: responseLang
    };

  } catch (err) {
    console.error('[Gemini FC Error]', err.message);
    return null;
  }
}

// Simple emotion detector for function calling responses
function detectEmotion(text) {
  const lower = (text || '').toLowerCase();
  if (/🔥|fire|insane|amazing|wow|awesome|incredible|stunner|great|super|சூப்பர்|அருமை/.test(lower)) return 'excited';
  if (/sorry|apolog|unfortunately|unavailable|oops|மன்னிக்க|माफ/.test(lower)) return 'empathetic';
  if (/think|hmm|let me|searching|looking|checking|பார்க்கிறேன்|देखता/.test(lower)) return 'thinking';
  if (/haha|lol|😄|😂|funny|joke/.test(lower)) return 'playful';
  if (/bye|sleep|closing|goodbye|போறேன்|बंद/.test(lower)) return 'happy';
  if (/!\s*$|ooh|yeah|let's|check out|here|இதோ|ये रहा|found/.test(lower)) return 'happy';
  return 'neutral';
}

// ══════════════════════════════════════════════════════════════════════════════
// TIER 3: GROQ CLOUD (Llama 3.3 70B) — TEXT-ONLY FALLBACK
// ══════════════════════════════════════════════════════════════════════════════
// Falls back to the old JSON-text-generation approach when Gemini is unavailable.
// Still works, just less reliable than native function calling.
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
// TIER 4: SMART FALLBACK — Local product matching when ALL LLMs are down
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
const NAVIGATION_PHONETIC_OVERRIDES = [
  { patterns: ['shop page', 'shop go', 'shop-ku po', 'shop ku po', 'shop la po', 'go to shop', 'open shop', 'show shop', 'shop-la', 'shop pannu',
               'சாப்ட் பேஜ்', 'சாப் பேஜ்', 'ஷாப் பேஜ்', 'ஷாப் போ', 'ஷாப்ல போ', 'கடை பேஜ்', 'கடைக்கு போ', 'கடையில போ', 'கடை போ',
               'शॉप पेज', 'शॉप पर जाओ', 'दुकान पेज', 'दुकान पर जाओ', 'दुकान जाओ'],
    route: '/shop' },
  { patterns: ['cart page', 'cart go', 'go to cart', 'open cart', 'cart-ku po', 'cart pannu',
               'கார்ட் பேஜ்', 'கார்ட் போ', 'கார்ட்ல போ',
               'कार्ट पेज', 'कार्ट पर जाओ'],
    route: '/cart' },
  { patterns: ['deals page', 'deals go', 'go to deals', 'open deals', 'deals-ku po',
               'டீல்ஸ் பேஜ்', 'ஆஃபர் பேஜ்',
               'डील्स पेज', 'ऑफर पेज'],
    route: '/deals' },
  { patterns: ['account page', 'profile page', 'go to account', 'go to profile', 'open account', 'open profile', 'my account page',
               'அக்கவுண்ட் பேஜ்', 'புரொஃபைல் பேஜ்',
               'अकाउंट पेज', 'प्रोफाइल पेज'],
    route: '/profile' },
  { patterns: ['checkout page', 'go to checkout', 'checkout go',
               'செக்அவுட் பேஜ்', 'செக்அவுட் போ',
               'चेकआउट पेज', 'चेकआउट जाओ'],
    route: '/checkout' },
  { patterns: ['home page', 'go home', 'go to home', 'main page', 'normal page', 'landing page',
               'ஹோம் பேஜ்', 'ஹோம் போ', 'நார்மல் பேஜ்',
               'होम पेज', 'होम जाओ', 'मेन पेज'],
    route: '/' },
  { patterns: ['mens page', "men's page", 'go to mens', 'men page',
               'ஆண்கள் பேஜ்', 'மென்ஸ் பேஜ்',
               'मेन्स पेज', 'पुरुष पेज'],
    route: '/shop/mens' },
  { patterns: ['womens page', "women's page", 'go to womens', 'women page',
               'பெண்கள் பேஜ்', 'உமன்ஸ் பேஜ்',
               'विमेंस पेज', 'महिला पेज'],
    route: '/shop/womens' }
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

  // ═══ STEP 0: PHONETIC NAVIGATION DISAMBIGUATOR (HIGHEST PRIORITY) ═══
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
  const navIntentMatch = lower.match(/(?:go to|open|take me to|navigate to|போ|போங்க|जाओ|पर जाओ|page|பேஜ்|பக்கம்|पेज)/);

  // 1. Positional Commands (Screen Awareness) — 0-based index
  const positionalMatch = lower.match(/(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|top|bottom|number \d|முதல்|முதலாவது|இரண்டாவது|இரண்டாம்|மூன்றாவது|மூன்றாம்|நான்காவது|நான்காம்|ஐந்தாவது|ஆறாவது|ஏழாவது|எட்டாவது|பத்தாவது|கடைசி|पहला|पहली|दूसरा|दूसरी|तीसरा|तीसरी|चौथा|चौथी|पांचवा|छठा|सातवा|आठवा|आखिरी|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)/);
  if (positionalMatch && currentlyVisibleProducts && currentlyVisibleProducts.length > 0) {
    let index = 0;
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
    
    const rawNumMatch = lower.match(/(?:product|item|number|#)\s*(\d+)/);
    if (rawNumMatch) index = parseInt(rawNumMatch[1]) - 1;
    
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

  // 3. Standard Navigation Intents
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

    for (const p of products) {
      if (p.name && lower.includes(p.name.toLowerCase())) {
        exactProduct = p;
        break;
      }
    }

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

    if (exactProduct) {
       return {
         text: lang === 'tamil' ? "இதோ! " + exactProduct.name : "Found it! Opening " + exactProduct.name,
         actions: [{ action: "NAVIGATE_DETAIL", productId: exactProduct._id || exactProduct.id }],
         emotion: "excited",
         language: lang === 'tamil' ? 'ta' : 'en'
       };
    }

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
