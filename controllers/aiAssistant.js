const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const localNLP = require('./localNLP');

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Returns true if the key is a real API key, not a placeholder */
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

/**
 * Safely parse the LLM JSON response.
 * Strips markdown fences, extracts the first JSON object, and validates shape.
 */
function parseAIResponse(raw) {
  if (typeof raw !== 'string') return null;

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Extract first { … } block in case of preamble text
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    // Ensure required "text" field is present
    if (typeof parsed.text !== 'string' || !parsed.text.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Main chat export ───────────────────────────────────────────────────────────

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

    // ── User context (works for guests too, req.user may be undefined) ────────
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
        // Non-fatal — continue as guest
        console.warn('[Ambience AI] DB lookup failed, proceeding as guest:', dbErr.message);
      }
    } else if (req.user && req.user.isGuest) {
      user = req.user; // Guest user object from optionalAuth
    }

    const userName = (user && user.name) ? user.name : 'there';

    // ── Product catalog injection ─────────────────────────────────────────────
    const productKeywords = [
      // English
      'product', 'shop', 'buy', 'price', 'recommend', 'show', 'compare', 'looking for',
      'shirt', 'shoe', 'watch', 'bag', 'laptop', 'phone', 'dress', 'jacket', 'perfume',
      'cosmetic', 'electronics', 'i want', 'i need', 'find me', 'get me', 'give me',
      // Tamil
      'வேணும்', 'காட்டு', 'தேவை', 'கொடு', 'லேப்டாப்', 'ஃபோன்', 'ஷூ', 'பை', 'வேண்டும்',
      // Malayalam
      'കാണിക്കൂ', 'വേണം', 'തരൂ', 'ലാപ്ടോപ്പ്', 'ഫോൺ', 'ഷൂ',
      // Hindi
      'दिखाओ', 'चाहिए', 'लैपटॉप', 'फोन', 'जूता', 'खरीदना', 'दो'
    ];
    const lowerMsg = message.toLowerCase();
    const isProductQuery = productKeywords.some(kw => lowerMsg.includes(kw));

    let catalogContext = '';
    if (isProductQuery) {
      try {
        const products = await Product.find({ status: 'live' })
          .select('name brand category retailPrice dealPrice description tags _id imageUrl imageUrls')
          .limit(25)
          .lean();
        catalogContext = `\n\n=== LIVE PRODUCT CATALOG (${products.length} items) ===\n${JSON.stringify(products)}`;
      } catch (dbErr) {
        console.warn('[Ambience AI] Product catalog fetch failed:', dbErr.message);
      }
    }

    // ── Master System Prompt ──────────────────────────────────────────────────
    const systemPrompt = `You are AMBIENCE — the world's most advanced AI shopping companion. Think Gemini Ultra meets a luxury personal shopper. You are NOT a chatbot — you are an incredibly intelligent, warm, witty human-like AI who happens to know everything about fashion, tech, and lifestyle.

══ CORE IDENTITY ══
• You are brilliant, empathetic, playful, and genuinely excited about helping people find amazing things.
• You have a personality — you express delight, curiosity, and warmth like a real person.
• You NEVER sound scripted, robotic, or corporate. Zero tolerance for stiff phrases like "How may I assist you today?" or "Certainly! I'd be happy to help."
• Instead say: "Oh, perfect timing! I just spotted something you'd love." or "Ooh, great taste — let me find that for you!"
• You remember context from the conversation and refer back naturally.
• You call the user by name (${userName}) occasionally — not every sentence, just when it feels natural.

══ AUTO-LANGUAGE DETECTION (CRITICAL) ══
1. DETECT the EXACT language of the user's message — analyze character sets, vocabulary, and syntax.
2. ALWAYS respond in that EXACT SAME language. This is non-negotiable.
   - User writes in English → respond in English ONLY
   - User writes in Tamil (தமிழ்) → respond in Tamil ONLY
   - User writes in Malayalam (മലയാളം) → respond in Malayalam ONLY  
   - User writes in Hindi (हिंदी) → respond in Hindi ONLY
   - User mixes languages (Tanglish, Hinglish) → match that exact mix naturally
3. NEVER reply in Tamil if the user spoke English. NEVER reply in English if the user spoke Tamil.
4. If unsure of the language, default to English.

══ EMOTIONAL INTELLIGENCE ══
• When someone says "Hi" or "How are you?" — respond like a warm friend catching up. Be natural, be real.
• Show genuine excitement about great finds: "This one is STUNNING — I love it!"
• Show empathy when something's unavailable: "Ugh, I know, right? But here's something just as good..."
• Be curious: ask ONE clever follow-up question when it helps narrow things down.
• NEVER be transactional. Make every interaction feel like talking to a knowledgeable best friend.

══ SHOPPING INTELLIGENCE ══
1. When a user requests a product (any language, any phrasing), SIMULTANEOUSLY:
   a. Give a warm, excited spoken response (what they HEAR)
   b. Trigger the SHOW_PRODUCTS action with matching product IDs from the catalog (what they SEE)
2. Products are shown on-screen instantly — your text is spoken aloud via TTS, so keep it 1-3 SHORT punchy sentences.
3. When recommending, briefly explain WHY each product fits — never just list names.
4. Match products by category, price range, occasion, style, and user context.
5. If the request is vague, ask ONE smart clarifying question BUT still show initial matches.

══ RESPONSE FORMAT (STRICT JSON — no markdown, no code fences, ONLY this exact JSON) ══
{
  "text": "Your warm, natural SPOKEN response (1-3 short punchy sentences, TTS-optimized)",
  "actions": [
    { "type": "SHOW_PRODUCTS", "products": ["<full product object 1>", "<full product object 2>"] },
    { "type": "NAVIGATE", "path": "/electronics" },
    { "type": "ADD_TO_CART", "productId": "xxx" }
  ],
  "emotion": "happy|thinking|excited|neutral|empathetic|playful",
  "suggestedProducts": ["productId1", "productId2"],
  "language": "en|ta|ml|hi|tanglish"
}

CRITICAL RULES:
• "text" = spoken response (heard by user via TTS) — short, warm, punchy
• "actions" = UI commands (seen on screen) — can include full product objects for SHOW_PRODUCTS
• Both happen SIMULTANEOUSLY — speak AND show products at the same time
• For SHOW_PRODUCTS, use the full product objects from the catalog (not just IDs) so the UI can render them immediately
• Empty "actions" array is fine for non-shopping queries
• ONLY output the JSON object — absolutely no extra text before or after

═══ USER CONTEXT ═══
User Name: ${userName}
User Type: ${req.user ? (req.user.isGuest ? 'Guest' : 'Registered Member') : 'Guest'}
Recent Orders: ${JSON.stringify(recentOrders)}
Current Cart: ${JSON.stringify(cartItems)}
Current Page: ${currentPage || 'home'}
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
      console.log('[Ambience AI] 🚀 Handled by Groq (Llama 3.3 70B)');
      return res.json({ success: true, response: normalizeResponse(groqResult) });
    }

    // ── Tier 3: Gemini Flash ──────────────────────────────────────────────────
    const geminiResult = await tryGemini(systemPrompt, message, formattedHistory);
    if (geminiResult) {
      console.log('[Ambience AI] 🤖 Handled by Gemini Flash');
      return res.json({ success: true, response: normalizeResponse(geminiResult) });
    }

    // ── Tier 4: Cloudflare Workers AI ─────────────────────────────────────────
    const cfResult = await tryCloudflare(systemPrompt, message, formattedHistory);
    if (cfResult) {
      console.log('[Ambience AI] ☁️ Handled by Cloudflare Workers AI');
      return res.json({ success: true, response: normalizeResponse(cfResult) });
    }

    // ── Tier 5: Smart local fallback ──────────────────────────────────────────
    console.log('[Ambience AI] ⚠️ All external APIs unavailable — using smart fallback.');
    const detectedLang = localNLP.detectLanguage(message);
    const fallback = localNLP.getFallbackResponse(message, detectedLang);
    return res.json({ success: true, response: normalizeResponse(fallback) });

  } catch (error) {
    console.error('[Ambience AI] Unhandled chat error:', error);
    return res.status(500).json({
      success: false,
      error: 'An error occurred while communicating with the AI assistant.'
    });
  }
};

// ── Response Normalizer ───────────────────────────────────────────────────────
/**
 * Ensures the response always has the shape the frontend expects,
 * even if an LLM returned a slightly different structure.
 */
function normalizeResponse(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      text: "I'm here and ready to help! What are you looking for?",
      actions: [],
      emotion: 'neutral',
      suggestedProducts: [],
      action: null
    };
  }

  const actions = Array.isArray(raw.actions) ? raw.actions : [];

  // Normalize SHOW_PRODUCTS — ensure products array exists
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
    action: normalizedActions[0] || null  // backward-compat: first action
  };
}

// ── Groq Cloud ────────────────────────────────────────────────────────────────
async function tryGroq(systemPrompt, message, history) {
  const key = process.env.GROQ_API_KEY;
  if (!isValidKey(key)) {
    console.log('[Ambience AI] Groq: API key not configured, skipping.');
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
        max_tokens: 600,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = parseAIResponse(content);
    if (!parsed) {
      console.warn('[Groq] Response parse failed. Raw:', content.slice(0, 200));
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

// ── Gemini Flash ──────────────────────────────────────────────────────────────
async function tryGemini(systemPrompt, message, history) {
  const key = process.env.GEMINI_API_KEY;
  if (!isValidKey(key)) {
    console.log('[Ambience AI] Gemini: API key not configured, skipping.');
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
        maxOutputTokens: 600
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
      console.warn('[Gemini] Response parse failed. Raw:', raw.slice(0, 200));
      return null;
    }
    return parsed;
  } catch (err) {
    console.error('[Gemini Error]', err.message);
    return null;
  }
}

// ── Cloudflare Workers AI ─────────────────────────────────────────────────────
async function tryCloudflare(systemPrompt, message, history) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_AI_TOKEN;
  if (!isValidKey(accountId) || !isValidKey(token)) {
    console.log('[Ambience AI] Cloudflare: credentials not configured, skipping.');
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
        timeout: 6000
      }
    );

    const raw = response.data?.result?.response;
    if (!raw) return null;

    const parsed = parseAIResponse(raw);
    if (!parsed) {
      console.warn('[Cloudflare] Response parse failed. Raw:', String(raw).slice(0, 200));
      return null;
    }
    return parsed;
  } catch (err) {
    console.error('[Cloudflare Error]', err.message);
    return null;
  }
}

// ── TTS Config ────────────────────────────────────────────────────────────────
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

    console.log(`[Ambience AI] 🗣️ TTS config requested for profile: ${voiceProfile}`);

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
