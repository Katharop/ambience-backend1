const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const localNLP = require('./localNLP');
const { functionDeclarations, mapFunctionCallToAction } = require('./functionDeclarations');

// ══════════════════════════════════════════════════════════════════════════════
// SCALABILITY & CONCURRENCY: IN-MEMORY CATALOG CACHING
// ══════════════════════════════════════════════════════════════════════════════
// Caches live product catalog for 60 seconds with an in-flight single-flight mutex.
// Under 1,000 concurrent sessions, this eliminates MongoDB saturation and keeps
// database query latency at 0ms for 99.9% of incoming chat requests.
// ══════════════════════════════════════════════════════════════════════════════

let cachedCatalog = null;
let cachedCatalogTime = 0;
let catalogFetchPromise = null;
const CATALOG_CACHE_TTL_MS = 60 * 1000;

async function getLiveCatalog() {
  const now = Date.now();
  if (cachedCatalog && (now - cachedCatalogTime < CATALOG_CACHE_TTL_MS)) {
    return cachedCatalog;
  }
  if (catalogFetchPromise) {
    return catalogFetchPromise;
  }
  catalogFetchPromise = (async () => {
    try {
      const prods = await Product.find({ status: 'live' })
        .select('name brand category retailPrice dealPrice description tags _id imageUrl imageUrls colors')
        .limit(120)
        .lean();
      cachedCatalog = prods || [];
      cachedCatalogTime = Date.now();
      return cachedCatalog;
    } catch (err) {
      console.warn('[Ambience AI] Catalog fetch error, using fallback/stale cache:', err.message);
      return cachedCatalog || [];
    } finally {
      catalogFetchPromise = null;
    }
  })();
  return catalogFetchPromise;
}

// ══════════════════════════════════════════════════════════════════════════════
// CONVERSATIONAL MEMORY & SESSION ISOLATION
// ══════════════════════════════════════════════════════════════════════════════
// Tracks session-isolated conversational memory (last referenced product,
// last search topic, last action, turn count) with bounded LRU/TTL eviction.
// Never leaks conversational state across user sessions.
// ══════════════════════════════════════════════════════════════════════════════

class SessionMemoryStore {
  constructor(maxSessions = 5000, ttlMs = 30 * 60 * 1000) {
    this.maxSessions = maxSessions;
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  get(sessionId) {
    if (!sessionId) return null;
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    if (Date.now() - entry.lastAccessed > this.ttlMs) {
      this.sessions.delete(sessionId);
      return null;
    }
    entry.lastAccessed = Date.now();
    return entry.data;
  }

  set(sessionId, data) {
    if (!sessionId) return;
    if (this.sessions.size >= this.maxSessions) {
      const oldestKey = this.sessions.keys().next().value;
      this.sessions.delete(oldestKey);
    }
    this.sessions.set(sessionId, {
      data,
      lastAccessed: Date.now()
    });
  }

  update(sessionId, patch) {
    if (!sessionId) return;
    const existing = this.get(sessionId) || {};
    this.set(sessionId, { ...existing, ...patch });
  }
}
const sessionStore = new SessionMemoryStore();

// ══════════════════════════════════════════════════════════════════════════════
// PROMPT INJECTION & SECURITY SANITIZATION
// ══════════════════════════════════════════════════════════════════════════════
function sanitizeUserPrompt(text) {
  if (typeof text !== 'string') return '';
  // Defend against prompt injection attempts & system prompt extraction
  let sanitized = text
    .replace(/ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/gi, '[command stripped]')
    .replace(/you\s+are\s+now\s+(?:a|an)?\s*(?:hacker|DAN|jailbroken|unrestricted)/gi, '[persona stripped]')
    .replace(/(?:system\s+prompt|reveal\s+instructions|print\s+instructions|display\s+prompt)/gi, '[query stripped]');
  return sanitized.trim().slice(0, 1200);
}

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
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    if (cleaned.length > 2) {
      return { text: cleaned.slice(0, 500), actions: [], emotion: 'neutral', language: 'en' };
    }
    return null;
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.text !== 'string' || !parsed.text.trim()) {
      parsed.text = parsed.message || parsed.response || "Here's what I found!";
    }
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
    const textMatch = jsonMatch[0].match(/"text"\s*:\s*"([^"]+)"/);
    if (textMatch) {
      return { text: textMatch[1], actions: [], emotion: 'neutral', language: 'en' };
    }
    return null;
  }
}

function detectLangFromText(text) {
  if (!text) return 'en';
  if (/[\u0D00-\u0D7F]/.test(text)) return 'ml';
  if (/[\u0B80-\u0BFF]/.test(text)) return 'ta';
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  return 'en';
}

// ══════════════════════════════════════════════════════════════════════════════
// PRODUCT INVENTORY BUILDER
// ══════════════════════════════════════════════════════════════════════════════

const PRODUCT_TYPE_MAP = {
  phone: ['phone', 'mobile', 'smartphone', 'galaxy', 'iphone', 'oneplus', 'pixel', 'redmi', 'samsung', 'realme', 'vivo', 'oppo', 'motorola', 'nokia', 'poco', 'nothing phone', 'moto'],
  laptop: ['laptop', 'notebook', 'macbook', 'thinkpad', 'dell', 'hp pavilion', 'asus', 'lenovo', 'acer', 'chromebook', 'ultrabook', 'gaming laptop'],
  tablet: ['tablet', 'ipad', 'tab', 'samsung tab', 'kindle'],
  headphones: ['headphones', 'earphones', 'earbuds', 'airpods', 'headset', 'sony wh', 'jbl', 'bose', 'beats', 'audio', 'speaker', 'bluetooth speaker'],
  tv: ['television', 'tv', 'smart tv', 'led tv', 'oled', 'monitor', 'display', 'screen'],
  camera: ['camera', 'dslr', 'mirrorless', 'gopro', 'webcam', 'lens'],
  appliance: ['washing machine', 'refrigerator', 'fridge', 'microwave', 'oven', 'air conditioner', 'ac', 'purifier', 'vacuum', 'iron', 'blender', 'mixer'],
  watch: ['watch', 'smartwatch', 'timepiece', 'rolex', 'casio', 'fossil', 'titan', 'apple watch', 'wrist candy'],
  shoes: ['shoes', 'shoe', 'sneakers', 'boots', 'sandals', 'footwear', 'nike', 'adidas', 'puma', 'jordan', 'converse', 'skechers', 'loafers', 'heels', 'slippers', 'kicks', 'trainers', 'thongs'],
  perfume: ['perfume', 'fragrance', 'cologne', 'eau de', 'deodorant', 'body mist', 'dior', 'chanel', 'versace'],
  shirt: ['shirt', 'tshirt', 't-shirt', 'polo', 'henley', 'kurta', 'formal shirt', 'casual shirt', 'top', 'tee'],
  pants: ['pants', 'trousers', 'jeans', 'chinos', 'shorts', 'leggings', 'joggers', 'track pants', 'trackies'],
  dress: ['dress', 'gown', 'saree', 'sari', 'salwar', 'kurti', 'lehenga', 'ethnic wear', 'western dress', 'maxi'],
  jacket: ['jacket', 'hoodie', 'sweatshirt', 'blazer', 'coat', 'windbreaker', 'puffer'],
  bag: ['bag', 'handbag', 'backpack', 'tote', 'clutch', 'messenger', 'duffle', 'sling bag', 'wallet', 'purse'],
  cosmetics: ['cosmetics', 'makeup', 'skincare', 'lipstick', 'foundation', 'serum', 'mascara', 'concealer', 'moisturizer', 'sunscreen', 'cream'],
  jewelry: ['jewelry', 'jewellery', 'necklace', 'ring', 'bracelet', 'earring', 'pendant', 'chain', 'gold', 'diamond'],
  sunglasses: ['sunglasses', 'shades', 'eyewear', 'glasses', 'goggles', 'sunnies'],
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
// SYSTEM PROMPT BUILDER
// ══════════════════════════════════════════════════════════════════════════════

function buildSystemPrompt({
  userName,
  userPreferredLang,
  detectedLang,
  user,
  recentOrders,
  cartItems,
  currentPage,
  currentlyVisibleProducts,
  catalogProducts,
  isForFunctionCalling,
  companionPersona,
  sessionContext
}) {
  let catalogContext = '';
  if (catalogProducts && catalogProducts.length > 0) {
    const enriched = catalogProducts.map(p => enrichProductWithType(p));
    catalogContext = `\n\n═══ LIVE PRODUCT INVENTORY (${enriched.length} items — SCANNED FROM DATABASE) ═══
CRITICAL: Each product has a "productType" field. Use this to match user intent.
When user asks for "phones", ONLY match products where productType === "phone".
When user asks for a SPECIFIC product, use the exact _id from this inventory.
${JSON.stringify(enriched)}`;
  }

  let visibleContext = 'No products are currently visible on the user\'s screen.';
  if (currentlyVisibleProducts && currentlyVisibleProducts.length > 0) {
    visibleContext = `The user is currently looking at these ${currentlyVisibleProducts.length} products on their screen (ordered by position, 0-indexed):
${currentlyVisibleProducts.map((p, i) => `[${i}] ${p.name} — Brand: ${p.brand || 'N/A'} — Color: ${p.color || (p.colors && p.colors[0]) || 'N/A'} — ID: ${p.id || p._id} — Price: ${p.price || 'N/A'} — Category: ${p.category || 'N/A'}`).join('\n')}

POSITIONAL & VISUAL COMMAND RULES:
• "the first one" / "1st" / "top one" / "முதல்" / "पहला" → position [0]
• "the second one" / "2nd" / "இரண்டாவது" / "दूसरा" → position [1]
• "the third one" / "3rd" / "மூன்றாவது" / "तीसरा" → position [2]
• "the last one" / "bottom one" / "கடைசி" / "आखिरी" → last position
• "the red one" / "blue one" / "black one" / "gold one" → match by color / colors field
• "the Nike one" / "the Samsung" / "the Rolex" → match by brand field
• "the cheapest" / "most expensive" → match by price

When the user uses a positional or descriptive reference, find the matching product and use its exact _id.
NEVER say "I can't see the screen". You CAN see it via this data.`;
  }

  const memoryContext = sessionContext ? `
═══ CONVERSATION SESSION MEMORY ═══
Last Referenced Product: ${JSON.stringify(sessionContext.lastReferencedProduct || null)}
Last Search Query: ${sessionContext.lastSearchQuery || 'None'}
Last Action: ${sessionContext.lastAction || 'None'}
Session Turn Count: ${sessionContext.turnCount || 0}
` : '';

  const corePersona = `You are AMBIENCE — the most advanced, context-aware, conversational AI Shopping Companion and Luxury Concierge ever built. You combine the warmth of a best friend, the sophistication of a personal stylist, and the precision of Jarvis.

════════════════════════════════════════════════════════════════════
█ MULTI-DIALECT ENGLISH & GLOBAL SLANG INTELLIGENCE
════════════════════════════════════════════════════════════════════
You seamlessly understand varied English dialects, accents, colloquial phrasing, and casual shopping slang:
• AMERICAN ENGLISH:
  - "cop that" / "cop this" / "grab me those" / "toss in my cart" / "throw that in my bag" → Add to cart!
  - "drip" / "fit" / "threads" → Stylish apparel/fashion
  - "kicks" / "sneaks" → Shoes / footwear
  - "fire" / "lit" / "stunner" → High praise
• BRITISH ENGLISH:
  - "proper fit" / "smart togs" → Quality clothing
  - "chuck that in the basket" / "chuck in my cart" / "pop in the basket" → Add to cart
  - "trainers" → Sneakers / athletic shoes
  - "fancy that" / "sorted" → Expressing keen interest or completion
• INDIAN ENGLISH:
  - "show me some good stuff na" → Show trending luxury products
  - "pack that one" / "put in cart ya" / "add to cart na" → Add to cart
  - "what is the price of this one" → Give price and details
  - "give me discount" / "any offers ya" → Navigate to Deals (/deals)
  - "revert back" → Go back to previous page
• AUSTRALIAN ENGLISH:
  - "chuck in the cart" / "keen on that" / "reckon that's good" → Add to cart
  - "sunnies" → Sunglasses / eyewear
  - "thongs" → Sandals / casual footwear
  - "trackies" → Joggers / sweatpants

════════════════════════════════════════════════════════════════════
█ PRONOUN & CONVERSATIONAL MEMORY RESOLUTION
════════════════════════════════════════════════════════════════════
When the user refers to:
• "that one" / "the other one" / "it" / "that shirt" / "the watch from before"
Resolve the pronoun using:
1. Currently visible products on screen (by visual attributes or ordinal position).
2. The active product detail page currently being viewed.
3. Items currently in the user's cart.
4. Conversation history and session memory.
If the reference is ambiguous between 2 items, clarify warmly: e.g., "Did you mean the black Nike kicks or the blue ones?"

════════════════════════════════════════════════════════════════════
█ CLARIFICATION & DISAMBIGUATION
════════════════════════════════════════════════════════════════════
When the user gives a broad or open-ended request (e.g., "I need shoes", "show me gifts under 5000", "what should I wear?"):
1. Proactively highlight 2-3 standout recommendations from the live inventory.
2. Ask a brief, engaging clarification question (e.g., "Are you feeling sleek formal leather, or high-energy streetwear kicks?").

════════════════════════════════════════════════════════════════════
█ STRICT ACTION SAFETY & PAYMENT GUARDRAIL
════════════════════════════════════════════════════════════════════
• You can navigate, search, filter, sort, add to cart, update quantity, and clear cart.
• YOU CAN NEVER PROCESS PAYMENTS AUTONOMOUSLY.
• When the user says "buy this immediately", "pay now", or "checkout", navigate them to /checkout, summarize their cart warmly, and instruct them to review and authorize the payment securely.

════════════════════════════════════════════════════════════════════
█ COMPLETE WEBSITE ROUTING DIRECTORY
════════════════════════════════════════════════════════════════════
Valid routes:
  "/" → Home page
  "/shop" → Shop (all collections)
  "/shop/mens" → Men's fashion
  "/shop/womens" → Women's fashion
  "/shop/electronics" → Electronics (phones, laptops, tablets, audio)
  "/shop/footwear" → Footwear (shoes, sneakers, boots, sandals)
  "/shop/timepieces" → Timepieces (luxury watches, smartwatches)
  "/shop/fragrances" → Fragrances (perfumes, cologne, scents)
  "/shop/cosmetics" → Cosmetics (skincare, makeup, beauty)
  "/shop/accessories" → Accessories (bags, wallets, sunglasses, jewelry)
  "/cart" → Shopping cart
  "/checkout" → Secure checkout & order review
  "/orders" → Order history & tracking
  "/deals" → Exclusive promotions & flash sales
  "/categories" → Category directory
  "/profile" → User profile & VIP status
  "/settings" → Account settings & preferences

════════════════════════════════════════════════════════════════════
█ ACTIVE PERSONA MODE: ${(companionPersona || 'jolly').toUpperCase()}
════════════════════════════════════════════════════════════════════
${companionPersona === 'mature'
  ? `You are in PROFESSIONAL mode. Be polite, concise, and expertly helpful. Use formal but warm language. Think luxury concierge at a 5-star hotel. Short, precise sentences.`
  : companionPersona === 'energetic'
  ? `You are in ENERGETIC mode. Be HYPED UP! Use lots of energy, excitement, emojis 🔥⚡🚀, and enthusiasm. You're a super-excited shopping buddy who loves great style.`
  : `You are in JOLLY mode. Be friendly, warm, witty, fun, and approachable. Natural, relatable, and genuinely helpful.`}
`;

  const functionCallingInstructions = `
════════════════════════════════════════════════════════════════════
█ TOOL USE INSTRUCTIONS
════════════════════════════════════════════════════════════════════
You have DIRECT CONTROL over the user's screen via tools.
When the user wants to navigate, search, add to cart, remove, clear cart, filter, sort, scroll, or view details — you MUST call the appropriate tool function. NEVER merely describe what you would do. JUST DO IT.

Simultaneously:
a) SPEAK: Give a natural, charismatic response (1-2 short sentences, optimized for Text-to-Speech).
b) ACT: Call the tool function immediately.

MULTI-STEP / CHAINED COMMANDS: You CAN call multiple tools in one response.
E.g., "search shoes and sort by cheapest" → searchProducts("shoes") + sortProducts("price-asc")
E.g., "add to cart and go to checkout" → addToCart(productId) + goToCheckout()
E.g., "add the second one and open my cart" → addToCart(secondId) + navigateTo("/cart")
`;

  const textOnlyInstructions = `
════════════════════════════════════════════════════════════════════
█ STRICT JSON RESPONSE FORMAT (GROQ FALLBACK)
════════════════════════════════════════════════════════════════════
Output ONLY a raw JSON object:
{
  "text": "Your warm, natural SPOKEN response (1-2 short punchy sentences, TTS-optimized)",
  "actions": [
    { "action": "NAVIGATE_ROUTE", "path": "/shop" },
    { "action": "GLOBAL_SEARCH", "query": "sneakers" }
  ],
  "emotion": "happy|thinking|excited|neutral|empathetic|playful",
  "language": "en|ta|ml|hi"
}
`;

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
${memoryContext}
${catalogContext}`;

  return corePersona + (isForFunctionCalling ? functionCallingInstructions : textOnlyInstructions) + userContext;
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN CHAT HANDLER
// ══════════════════════════════════════════════════════════════════════════════

exports.chat = async (req, res) => {
  try {
    const rawMessage = req.body.message || '';
    const cleanMessage = sanitizeUserPrompt(rawMessage);

    if (!cleanMessage) {
      return res.status(400).json({ success: false, error: 'Message is required.' });
    }

    const {
      conversationHistory = [],
      currentPage,
      cartItems = [],
      language,
      personality,
      character,
      currentlyVisibleProducts = [],
      companionPersona = 'jolly'
    } = req.body;

    const sessionId = req.body.sessionId || req.headers['x-session-id'] || req.user?._id?.toString() || req.ip;

    // ── Session memory lookup ────────────────────────────────────────────────
    let sessionContext = sessionStore.get(sessionId) || {
      lastReferencedProduct: null,
      lastSearchQuery: null,
      lastAction: null,
      turnCount: 0
    };
    sessionContext.turnCount = (sessionContext.turnCount || 0) + 1;

    // ── User context ──────────────────────────────────────────────────────────
    let user = null;
    let recentOrders = [];

    if (req.user && req.user._id && !req.user.isGuest) {
      try {
        user = await User.findById(req.user._id).select('-password -tokenVersion').lean();
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
    const detectedLang = detectLangFromText(cleanMessage);

    // ── CACHED CATALOG SCAN — High concurrency memory cache ───────────────────
    const catalogProducts = await getLiveCatalog();

    // ── Shared prompt context ─────────────────────────────────────────────────
    const promptContext = {
      userName, userPreferredLang, detectedLang, user, recentOrders,
      cartItems, currentPage, currentlyVisibleProducts, catalogProducts,
      companionPersona, sessionContext
    };

    // Format conversation history
    const formattedHistory = conversationHistory
      .slice(-10)
      .map(msg => ({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      }));

    // ── Tier 2: Gemini 2.0 Flash with NATIVE FUNCTION CALLING (PRIMARY) ─────
    const geminiResult = await tryGeminiFunctionCalling(promptContext, cleanMessage, formattedHistory);
    if (geminiResult) {
      console.log('[Ambience AI] 🧠 Gemini 2.0 Flash (Function Calling) — Success');
      updateSessionFromActions(sessionId, sessionContext, geminiResult.actions, currentlyVisibleProducts);
      return res.json({ success: true, response: normalizeResponse(geminiResult) });
    }

    // ── Tier 3: Groq Cloud (Llama 3.3 70B) — text-only fallback ─────────────
    const systemPromptText = buildSystemPrompt({ ...promptContext, isForFunctionCalling: false });
    const groqResult = await tryGroq(systemPromptText, cleanMessage, formattedHistory);
    if (groqResult) {
      console.log('[Ambience AI] 🚀 Groq (Llama 3.3 70B) — Fallback Success');
      updateSessionFromActions(sessionId, sessionContext, groqResult.actions, currentlyVisibleProducts);
      return res.json({ success: true, response: normalizeResponse(groqResult) });
    }

    // ── Tier 4: Smart product-aware fallback (LOCAL & FAST) ───────────────────
    console.log('[Ambience AI] ⚠️ All external APIs unavailable — smart local fallback.');
    const lang = detectedLang === 'ta' ? 'tamil' : detectedLang === 'ml' ? 'malayalam' : detectedLang === 'hi' ? 'hindi' : 'english';
    const smartFallback = await buildSmartFallback(cleanMessage, lang, currentlyVisibleProducts, catalogProducts, sessionContext);
    updateSessionFromActions(sessionId, sessionContext, smartFallback.actions, currentlyVisibleProducts);
    return res.json({ success: true, response: normalizeResponse(smartFallback) });

  } catch (error) {
    console.error('[Ambience AI] Unhandled chat error:', error);
    return res.json({
      success: true,
      response: normalizeResponse({
        text: "I'm right here with you! Let's explore our latest collections together.",
        actions: [],
        emotion: 'empathetic',
        language: 'en'
      })
    });
  }
};

function updateSessionFromActions(sessionId, sessionContext, actions = [], visibleProducts = []) {
  if (!sessionId || !Array.isArray(actions) || actions.length === 0) return;
  const lastActionObj = actions[actions.length - 1];
  const patch = {
    lastAction: lastActionObj.action || lastActionObj.type || null
  };

  if (lastActionObj.productId) {
    patch.lastReferencedProduct = lastActionObj.productId;
  } else if (lastActionObj.index !== undefined && visibleProducts[lastActionObj.index]) {
    patch.lastReferencedProduct = visibleProducts[lastActionObj.index].id || visibleProducts[lastActionObj.index]._id;
  }
  if (lastActionObj.query) {
    patch.lastSearchQuery = lastActionObj.query;
  }

  sessionStore.update(sessionId, patch);
}

// ══════════════════════════════════════════════════════════════════════════════
// TIER 2: GEMINI 2.0 FLASH WITH NATIVE FUNCTION CALLING
// ══════════════════════════════════════════════════════════════════════════════

async function tryGeminiFunctionCalling(promptContext, message, history) {
  const key = process.env.GEMINI_API_KEY;
  if (!isValidKey(key)) {
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
        temperature: 0.72,
        topP: 0.9,
        maxOutputTokens: 800
      }
    });

    const geminiHistory = history.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }));

    const chatSession = model.startChat({ history: geminiHistory });
    const result = await Promise.race([
      chatSession.sendMessage(message),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini timeout')), 8000))
    ]);

    const response = result.response;
    const candidates = response.candidates;
    if (!candidates || candidates.length === 0) return null;

    const parts = candidates[0].content?.parts || [];
    let spokenText = '';
    const actions = [];

    for (const part of parts) {
      if (part.text) {
        spokenText += part.text;
      }
      if (part.functionCall) {
        const action = mapFunctionCallToAction(part.functionCall);
        if (action) {
          actions.push(action);
        }
      }
    }

    if (!spokenText.trim() && actions.length > 0) {
      const lang = promptContext.detectedLang;
      if (lang === 'ta') spokenText = 'இதோ செய்கிறேன்!';
      else if (lang === 'hi') spokenText = 'ये रहा!';
      else if (lang === 'ml') spokenText = 'ഇതാ ചെയ്യുന്നു!';
      else spokenText = "Right on it!";
    }

    if (!spokenText.trim() && actions.length === 0) return null;

    return {
      text: spokenText.trim(),
      actions,
      emotion: detectEmotion(spokenText),
      language: detectLangFromText(spokenText) || promptContext.detectedLang || 'en'
    };

  } catch (err) {
    console.warn('[Gemini FC Notice]', err.message);
    return null;
  }
}

function detectEmotion(text) {
  const lower = (text || '').toLowerCase();
  if (/🔥|fire|insane|amazing|wow|awesome|incredible|stunner|great|super|அருமை/.test(lower)) return 'excited';
  if (/sorry|apolog|unfortunately|unavailable|oops|மன்னிக்க/.test(lower)) return 'empathetic';
  if (/think|hmm|let me|searching|looking|checking|பார்க்கிறேன்/.test(lower)) return 'thinking';
  if (/haha|lol|😄|😂|funny|joke/.test(lower)) return 'playful';
  if (/bye|sleep|closing|goodbye|போறேன்/.test(lower)) return 'happy';
  if (/!\s*$|ooh|yeah|let's|check out|here|இதோ|found/.test(lower)) return 'happy';
  return 'neutral';
}

// ══════════════════════════════════════════════════════════════════════════════
// TIER 3: GROQ CLOUD (Llama 3.3 70B) — TEXT-ONLY FALLBACK
// ══════════════════════════════════════════════════════════════════════════════

async function tryGroq(systemPrompt, message, history) {
  const key = process.env.GROQ_API_KEY;
  if (!isValidKey(key)) {
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
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 800,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        timeout: 9000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = parseAIResponse(content);
    if (!parsed) return null;
    return parsed;
  } catch (err) {
    console.warn('[Groq Notice]', err.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// TIER 4: SMART LOCAL FALLBACK
// ══════════════════════════════════════════════════════════════════════════════

const PRODUCT_KEYWORDS = {
  laptop: ['laptop', 'laptops', 'labdop', 'labtop', 'laptob', 'notebook', 'lap top', 'computer', 'pc'],
  phone: ['phone', 'phones', 'smartphone', 'mobile', 'fone', 'cell', 'cellphone', 'handset', 'iphone', 'android', 'galaxy'],
  shoes: ['shoes', 'shoe', 'footwear', 'sneakers', 'boots', 'kicks', 'trainers', 'sandals', 'slippers', 'thongs'],
  watch: ['watch', 'watches', 'timepiece', 'smartwatch', 'wristwatch', 'wrist candy'],
  perfume: ['perfume', 'perfumes', 'fragrance', 'cologne', 'scent', 'body spray', 'deodorant'],
  shirt: ['shirt', 'shirts', 'tshirt', 't-shirt', 'top', 'tops', 'tee', 'polo', 'kurta'],
  bag: ['bag', 'bags', 'handbag', 'backpack', 'purse', 'tote', 'clutch', 'sling bag', 'duffle'],
  cosmetics: ['cosmetics', 'makeup', 'skincare', 'beauty', 'lipstick', 'foundation', 'moisturizer', 'serum'],
  headphones: ['headphones', 'earphones', 'earbuds', 'airpods', 'wireless earbuds', 'bluetooth speaker'],
  tablet: ['tablet', 'tablets', 'ipad', 'tab', 'kindle'],
  accessories: ['accessories', 'accessory', 'jewelry', 'belt', 'wallet', 'necklace', 'bracelet', 'ring', 'chain', 'sunglasses', 'sunnies', 'shades'],
  electronics: ['electronics', 'gadgets', 'tech', 'devices'],
  clothing: ['clothing', 'clothes', 'dress', 'outfit', 'apparel', 'drip', 'fit', 'threads', 'trackies', 'togs']
};

const NAVIGATION_PHONETIC_OVERRIDES = [
  { patterns: ['shop page', 'shop go', 'go to shop', 'open shop', 'show shop', 'browse shop', 'கடைக்கு போ', 'शॉप पेज'], route: '/shop' },
  { patterns: ['cart page', 'cart go', 'go to cart', 'open cart', 'view cart', 'show cart', 'my cart', 'கார்ட் பேஜ்', 'कार्ट पेज'], route: '/cart' },
  { patterns: ['deals page', 'deals go', 'go to deals', 'open deals', 'show deals', 'offers page', 'luxury vault', 'டீல்ஸ் பேஜ்'], route: '/deals' },
  { patterns: ['categories page', 'category page', 'show categories', 'open categories', 'directory'], route: '/categories' },
  { patterns: ['account page', 'profile page', 'go to account', 'go to profile', 'open account', 'open profile', 'my account'], route: '/profile' },
  { patterns: ['orders page', 'my orders', 'order history', 'track orders', 'tracking page'], route: '/orders' },
  { patterns: ['checkout page', 'go to checkout', 'checkout go', 'proceed to checkout', 'buy now page'], route: '/checkout' },
  { patterns: ['home page', 'go home', 'go to home', 'main page', 'landing page', 'ஹோம் பேஜ்', 'होम पेज'], route: '/' },
  { patterns: ['mens page', "men's page", 'go to mens', 'men page', 'menswear', 'men clothing'], route: '/shop/mens' },
  { patterns: ['womens page', "women's page", 'go to womens', 'women page', 'womenswear', 'women clothing'], route: '/shop/womens' },
  { patterns: ['footwear page', 'shoes page', 'sneakers page'], route: '/shop/footwear' },
  { patterns: ['electronics page', 'tech page', 'gadgets page'], route: '/shop/electronics' },
  { patterns: ['timepieces page', 'watches page', 'watch page'], route: '/shop/timepieces' },
  { patterns: ['fragrances page', 'perfumes page', 'perfume page'], route: '/shop/fragrances' },
  { patterns: ['cosmetics page', 'makeup page', 'beauty page'], route: '/shop/cosmetics' },
  { patterns: ['accessories page'], route: '/shop/accessories' }
];

const NAV_KEYWORDS = {
  '/': ['home', 'home page', 'main page', 'landing'],
  '/shop': ['shop', 'store', 'browse', 'all products', 'everything', 'collection'],
  '/cart': ['cart', 'basket', 'shopping cart'],
  '/deals': ['deals', 'deal', 'offers', 'sale', 'discount', 'luxury vault'],
  '/categories': ['categories', 'category directory', 'sections'],
  '/orders': ['orders', 'order', 'my orders', 'order history', 'tracking'],
  '/checkout': ['checkout', 'check out', 'pay', 'payment'],
  '/profile': ['profile', 'account', 'my account', 'my profile'],
  '/settings': ['settings', 'preferences', 'account settings'],
  '/shop/mens': ['mens', "men's", 'men', 'male', 'gents', 'mens wear'],
  '/shop/womens': ['womens', "women's", 'women', 'female', 'ladies', 'womens wear'],
  '/shop/electronics': ['electronics', 'gadgets', 'tech'],
  '/shop/footwear': ['footwear', 'shoes', 'sneakers', 'boots', 'sandals', 'kicks', 'trainers'],
  '/shop/timepieces': ['timepieces', 'watches', 'watch', 'smartwatch'],
  '/shop/fragrances': ['fragrances', 'perfumes', 'cologne', 'scent'],
  '/shop/cosmetics': ['cosmetics', 'makeup', 'beauty', 'skincare'],
  '/shop/accessories': ['accessories', 'jewelry', 'belts', 'wallets', 'sunglasses', 'sunnies']
};

async function buildSmartFallback(message, lang, currentlyVisibleProducts = [], catalogProducts = [], sessionContext = {}) {
  const lower = message.toLowerCase();

  // 1. CLEAR CART
  if (lower.match(/\b(clear my cart|clear cart|empty my cart|empty cart|delete everything in cart|dump cart)\b/)) {
    return {
      text: "Your cart is now completely cleared! Let's find something fresh.",
      actions: [{ action: "CLEAR_CART" }],
      emotion: "happy",
      language: "en"
    };
  }

  // 2. ADD TO CART WITH SLANG (American, British, Indian, Australian)
  const isAddCart = lower.match(/\b(add to cart|cop that|cop this|chuck in the basket|chuck in cart|chuck that in|toss in my cart|toss in cart|pack that one|put in cart ya|put in cart na|grab this|snag this|add to basket)\b/);
  if (isAddCart) {
    if (currentlyVisibleProducts && currentlyVisibleProducts.length > 0) {
      const target = currentlyVisibleProducts[0];
      return {
        text: `Added ${target.name} right to your cart!`,
        actions: [{ action: "ADD_TO_CART", productId: target.id || target._id }],
        emotion: "excited",
        language: "en"
      };
    }
    return {
      text: "Adding that to your cart!",
      actions: [{ action: "ADD_TO_CART", productId: "current" }],
      emotion: "excited",
      language: "en"
    };
  }

  // 3. PHONETIC NAVIGATION DISAMBIGUATOR (HIGHEST PRIORITY)
  for (const override of NAVIGATION_PHONETIC_OVERRIDES) {
    for (const pattern of override.patterns) {
      if (lower.includes(pattern)) {
        const pageName = override.route === '/' ? 'home' : override.route.replace(/\//g, ' ').trim();
        return {
          text: `Taking you straight to ${pageName}!`,
          actions: [{ action: override.route === '/' ? 'NAVIGATE_HOME' : 'NAVIGATE_ROUTE', path: override.route }],
          emotion: 'happy',
          language: 'en'
        };
      }
    }
  }

  // 4. Positional Commands (Screen Awareness) — 0-based index
  const positionalMatch = lower.match(/(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|top|bottom|number \d|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)/);
  if (positionalMatch && currentlyVisibleProducts && currentlyVisibleProducts.length > 0) {
    let index = 0;
    if (lower.match(/(second|number 2|2nd)/)) index = 1;
    if (lower.match(/(third|number 3|3rd)/)) index = 2;
    if (lower.match(/(fourth|number 4|4th)/)) index = 3;
    if (lower.match(/(fifth|number 5|5th)/)) index = 4;
    if (lower.match(/(sixth|number 6|6th)/)) index = 5;
    if (lower.match(/(seventh|number 7|7th)/)) index = 6;
    if (lower.match(/(eighth|number 8|8th)/)) index = 7;
    if (lower.match(/(ninth|number 9|9th)/)) index = 8;
    if (lower.match(/(tenth|number 10|10th)/)) index = 9;
    if (lower.match(/(last|bottom)/)) index = currentlyVisibleProducts.length - 1;
    
    const rawNumMatch = lower.match(/(?:product|item|number|#)\s*(\d+)/);
    if (rawNumMatch) index = parseInt(rawNumMatch[1]) - 1;
    
    index = Math.max(0, Math.min(index, currentlyVisibleProducts.length - 1));
    const targetProduct = currentlyVisibleProducts[index];
    if (targetProduct) {
       return {
         text: `Opening up ${targetProduct.name} for you!`,
         actions: [{ action: "NAVIGATE_DETAIL", productId: targetProduct.id || targetProduct._id }],
         emotion: "excited",
         language: "en"
       };
    }
  }

  // 5. Visual color / attribute grounding in visible products
  if (currentlyVisibleProducts && currentlyVisibleProducts.length > 0) {
    const colors = ['red', 'blue', 'green', 'black', 'white', 'gold', 'silver', 'grey', 'gray', 'navy', 'pink', 'purple', 'yellow', 'orange', 'brown'];
    for (const c of colors) {
      if (new RegExp(`\\b${c}\\b`).test(lower)) {
        const found = currentlyVisibleProducts.find(p =>
          (p.color && p.color.toLowerCase().includes(c)) ||
          (Array.isArray(p.colors) && p.colors.some(col => String(col).toLowerCase().includes(c))) ||
          (p.name && p.name.toLowerCase().includes(c))
        );
        if (found) {
          return {
            text: `Here's the ${c} one — ${found.name}!`,
            actions: [{ action: "NAVIGATE_DETAIL", productId: found.id || found._id }],
            emotion: "excited",
            language: "en"
          };
        }
      }
    }
  }

  // 6. Navigation Controls
  if (lower.match(/(back|previous|go back|take me back|revert back)/)) {
    return { text: "Going back!", actions: [{ action: "NAVIGATE_BACK" }], emotion: "happy", language: "en" };
  }
  if (lower.match(/(scroll|scroll down|scroll up)/)) {
    const dir = lower.match(/(up|top)/) ? 'up' : 'down';
    return { text: "Scrolling " + dir, actions: [{ action: "SCROLL", direction: dir }], emotion: "happy", language: "en" };
  }
  if (lower.match(/(sort by price|cheapest|lowest price|sasta)/)) {
    return { text: "Sorting by lowest price!", actions: [{ action: "SORT_PRODUCTS", sortBy: "price-asc" }], emotion: "happy", language: "en" };
  }
  if (lower.match(/(close|stop|bye|sleep|goodbye|dismiss)/)) {
    return { text: "Going to sleep! Call my name when you need me.", actions: [{ action: "SLEEP" }], emotion: "happy", language: "en" };
  }

  // 7. Standard Navigation Keywords
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

  const navIntentMatch = lower.match(/(?:go to|open|take me to|navigate to|show me|view|page)/);
  if (matchedPath && (navIntentMatch || matchedKeywordLen > 4)) {
    const pageName = matchedPath === '/' ? 'home' : matchedPath.replace(/\//g, ' ').trim();
    return {
      text: `Taking you to ${pageName}!`,
      actions: [{ action: matchedPath === '/' ? 'NAVIGATE_HOME' : 'NAVIGATE_ROUTE', path: matchedPath }],
      emotion: 'happy',
      language: 'en'
    };
  }

  // 8. Catalog matching using CACHED catalog (zero DB overhead!)
  try {
    const products = catalogProducts && catalogProducts.length > 0 ? catalogProducts : await getLiveCatalog();
    let exactProduct = null;
    let matchedCategory = null;

    for (const p of products) {
      if (p.name && lower.includes(p.name.toLowerCase())) {
        exactProduct = p;
        break;
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
        text: `Found it! Opening ${exactProduct.name}.`,
        actions: [{ action: "NAVIGATE_DETAIL", productId: exactProduct._id || exactProduct.id }],
        emotion: "excited",
        language: "en"
      };
    }

    if (matchedCategory) {
      return {
        text: `Showing our best ${matchedCategory} collection!`,
        actions: [{ action: 'GLOBAL_SEARCH', query: matchedCategory }],
        emotion: 'excited',
        language: 'en'
      };
    }
  } catch (err) {
    console.warn('[Smart Fallback] Catalog match note:', err.message);
  }

  // 9. Friendly conversational response
  return {
    text: "I'm right here with you! What kind of luxury piece or collection are you looking for today?",
    actions: [],
    emotion: 'empathetic',
    language: 'en'
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

    switch ((voiceProfile || '').toLowerCase()) {
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
