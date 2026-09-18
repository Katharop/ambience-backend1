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
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.text !== 'string' || !parsed.text.trim()) return null;
    return parsed;
  } catch {
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
    const detectedLang = detectLangFromText(message);

    // ── ALWAYS fetch product catalog for full store awareness ─────────────────
    let catalogContext = '';
    try {
      const products = await Product.find({ status: 'live' })
        .select('name brand category retailPrice dealPrice description tags _id imageUrl imageUrls')
        .limit(50)
        .lean();
      if (products.length > 0) {
        catalogContext = `\n\n═══ LIVE PRODUCT CATALOG (${products.length} items) ═══\n${JSON.stringify(products)}`;
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
█ LANGUAGE: STRICT AUTO-DETECT (NON-NEGOTIABLE)
════════════════════════════════════════════════════════════════════
1. ANALYZE the user's message character-by-character.
2. RESPOND in the EXACT SAME LANGUAGE the user used:
   • English message → English response ONLY
   • Tamil (தமிழ்) message → Tamil response ONLY (full native fluency, not Google Translate quality)
   • Malayalam (മലയാളം) message → Malayalam response ONLY
   • Hindi (हिंदी) message → Hindi response ONLY
   • Tanglish (Tamil+English mix) → Tanglish response (match their exact ratio of mixing)
   • Hinglish → Hinglish response
3. CRITICAL: If user writes "Show me laptops" in English → NEVER respond in Tamil.
   If user writes "எனக்கு ஒரு லேப்டாப் வேணும்" → RESPOND FULLY IN TAMIL.
4. Your Tamil must sound NATIVE — like a friend from Chennai, not a translation bot. Use colloquial Tamil where appropriate.
5. If you genuinely cannot determine the language, default to English.
6. The detected input language is: ${detectedLang}

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
█ SHOPPING INTELLIGENCE: SIMULTANEOUS SPEAK + ACT
════════════════════════════════════════════════════════════════════
When the user asks for products or navigation, you SIMULTANEOUSLY:
  a) SPEAK: Give a warm, excited 1-3 sentence spoken response (TTS-optimized, punchy)
  b) ACT: Execute the right UI action (SHOW_PRODUCTS, NAVIGATE, ADD_TO_CART)

Examples of what the user might say and how you respond:
• "Show me laptops" → Warm response + SHOW_PRODUCTS with laptop objects from catalog
• "எனக்கு ஒரு லேப்டாப் வேணும்" → Warm Tamil response + SHOW_PRODUCTS with laptops
• "Take me to shop" / "ஷாப் பேஜ் போ" → Friendly response + NAVIGATE to /shop
• "Go to electronics" → Response + NAVIGATE to /shop/electronics
• "Show me watches" → Response + SHOW_PRODUCTS with watches from catalog
• "Add this to cart" → Confirmation + ADD_TO_CART
• "What deals do you have?" → Response + NAVIGATE to /deals
• "Open my cart" → Response + NAVIGATE to /cart
• "Show men's fashion" → Response + NAVIGATE to /shop/mens

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
{
  "text": "Your warm, natural SPOKEN response (1-3 short punchy sentences, TTS-optimized)",
  "actions": [
    { "type": "SHOW_PRODUCTS", "products": [<full product objects from catalog>] },
    { "type": "NAVIGATE", "path": "/shop/electronics" },
    { "type": "ADD_TO_CART", "productId": "xxx" }
  ],
  "emotion": "happy|thinking|excited|neutral|empathetic|playful",
  "suggestedProducts": [],
  "language": "en|ta|ml|hi|tanglish|hinglish"
}

RULES:
• "text" = what the user HEARS via TTS. Keep it 1-3 short sentences. No JSON/code in text.
• "actions" = UI commands executed on screen. NAVIGATE uses exact route paths listed above.
• For SHOW_PRODUCTS, include FULL product objects from the catalog so the frontend can render them instantly.
• Both "text" and "actions" happen SIMULTANEOUSLY.
• ONLY output the JSON object. Absolutely nothing else before or after.
• If no action is needed, use empty actions array [].

═══ USER CONTEXT ═══
User: ${userName}
Type: ${req.user ? (req.user.isGuest ? 'Guest' : 'Registered Member') : 'Guest'}
Recent Orders: ${JSON.stringify(recentOrders)}
Cart: ${JSON.stringify(cartItems)}
Current Page: ${currentPage || 'home'}
Detected Language: ${detectedLang}
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

    // ── Tier 5: Smart contextual fallback (ZERO error messages) ───────────────
    console.log('[Ambience AI] ⚠️ All external APIs unavailable — using smart fallback.');
    const fallback = localNLP.getFallbackResponse(message, detectedLang === 'ta' ? 'tamil' : detectedLang === 'ml' ? 'malayalam' : detectedLang === 'hi' ? 'hindi' : 'english');
    return res.json({ success: true, response: normalizeResponse(fallback) });

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
