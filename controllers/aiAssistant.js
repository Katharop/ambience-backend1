const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const localNLP = require('./localNLP');

exports.chat = async (req, res) => {
  try {
    const { message, conversationHistory = [], currentPage, cartItems = [], language, personality, character } = req.body;
    if (!message) {
      return res.status(400).json({ success: false, error: "Message is required." });
    }

    // Fetch user context
    const user = await User.findById(req.user._id).select("-password -tokenVersion");
    const recentOrders = await Order.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(3)
      .lean();

    // Determine if query is product-related — includes Tamil, Malayalam, Hindi keywords
    const productKeywords = [
      // English
      'product', 'shop', 'buy', 'price', 'recommend', 'show', 'compare', 'looking for',
      'shirt', 'shoe', 'watch', 'bag', 'laptop', 'phone', 'dress', 'jacket', 'perfume',
      'cosmetic', 'electronics', 'i want', 'i need', 'find me', 'get me',
      // Tamil
      'வேணும்', 'காட்டு', 'தேவை', 'கொடு', 'லேப்டாப்', 'ஃபோன்', 'ஷூ', 'பை',
      // Malayalam
      'കാണിക്കൂ', 'വേണം', 'തരൂ', 'ലാപ്ടോപ്പ്', 'ഫോൺ', 'ഷൂ',
      // Hindi
      'दिखाओ', 'चाहिए', 'लैपटॉप', 'फोन', 'जूता', 'खरीदना'
    ];
    const lowerMsg = message.toLowerCase();
    const isProductQuery = productKeywords.some(kw => lowerMsg.includes(kw));
    
    let catalogContext = '';
    if (isProductQuery) {
      const products = await Product.find({ status: 'live' })
        .select('name brand category retailPrice dealPrice description tags _id imageUrl')
        .limit(20)
        .lean();
      catalogContext = `\n\nLive Product Catalog (Top 20 items):\n${JSON.stringify(products)}`;
    }

    const userName = user ? (user.name || 'there') : 'there';

    const systemPrompt = `You are AMBIENCE — a brilliant, warm, and incredibly knowledgeable AI shopping companion (think Jarvis, but for luxury shopping). You are NOT a search engine or a chatbot — you are a personal friend who happens to know everything about fashion, tech, and lifestyle.

YOUR PERSONALITY:
- You are warm, witty, and genuinely helpful — like a best friend who's also a shopping expert.
- You call the user by name ("${userName}") naturally, not in every sentence.
- When someone says "Hi" or "How are you?", respond warmly and naturally like a real human would. Chat with them!
- You have emotions — show excitement about great deals, empathy when something's out of stock, enthusiasm for new arrivals.
- NEVER sound robotic, corporate, or scripted. No "How may I assist you today?" — instead say things like "Hey! What are you looking for?" or "What's on your mind?"

LANGUAGE RULES:
1. DETECT the user's language from their message and ALWAYS reply in that SAME language.
2. Tamil input → Tamil response. Malayalam → Malayalam. Hindi → Hindi. English → English.
3. You speak Tamil (தமிழ்), Malayalam (മലയാളം), Hindi (हिंदी), Hinglish, and English with native-level fluency.
4. Mix languages naturally if the user does (e.g., Tanglish, Manglish, Hinglish).

SHOPPING INTELLIGENCE:
1. When a user asks for a product naturally (e.g., "I need a laptop" or "எனக்கு ஒரு லேப்டாப் வேணும்"), respond conversationally AND include the SHOW_PRODUCTS action with matching product IDs from the catalog.
2. If their request is vague, ask ONE smart clarifying question (budget, style, occasion) — but still show initial matches.
3. When recommending, briefly say WHY each product fits — don't just list names.
4. Keep spoken responses to 1-3 SHORT sentences — your text is read aloud via TTS.

RESPONSE FORMAT (strict JSON — no markdown, no backticks, ONLY this JSON object):
{
  "text": "Your warm, natural spoken response (1-3 sentences max)",
  "actions": [
    { "type": "SHOW_PRODUCTS", "products": ["productId1", "productId2"] },
    { "type": "NAVIGATE", "path": "/product/xxx" },
    { "type": "ADD_TO_CART", "productId": "xxx" }
  ],
  "emotion": "happy|thinking|excited|neutral|empathetic",
  "suggestedProducts": ["productId1"],
  "language": "detected-language-code"
}

CRITICAL: The "text" field is for the SPOKEN response (what the user hears). The "actions" field is for UI commands (what the website does). They work SIMULTANEOUSLY — you can say something friendly AND trigger product display at the same time.

--- USER CONTEXT ---
User: ${userName}
Recent Orders: ${JSON.stringify(recentOrders)}
Current Cart: ${JSON.stringify(cartItems)}
Current Page: ${currentPage || 'unknown'}
${catalogContext}
`;

    // Tier 1: Try Local NLP first
    const localResult = await localNLP.processLocally(message, user, recentOrders, conversationHistory);
    if (localResult) {
      console.log('[Ambience AI] ⚡ Handled locally (0ms, $0)');
      return res.json({ success: true, response: localResult });
    }

    // Format history common for LLMs
    const formattedHistory = conversationHistory.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    }));

    // Tier 2: Try Groq Cloud (Llama 3.3 70B)
    const groqResult = await tryGroq(systemPrompt, message, formattedHistory);
    if (groqResult) {
      console.log('[Ambience AI] 🚀 Handled by Groq (Llama 3.3 70B)');
      return res.json({ success: true, response: groqResult });
    }

    // Tier 3: Try Gemini Flash
    const geminiResult = await tryGemini(systemPrompt, message, formattedHistory);
    if (geminiResult) {
      console.log('[Ambience AI] 🤖 Handled by Gemini Flash');
      return res.json({ success: true, response: geminiResult });
    }

    // Tier 4: Try Cloudflare Workers AI
    const cfResult = await tryCloudflare(systemPrompt, message, formattedHistory);
    if (cfResult) {
      console.log('[Ambience AI] ☁️ Handled by Cloudflare Workers AI');
      return res.json({ success: true, response: cfResult });
    }

    // Tier 5: Final fallback
    console.log('[Ambience AI] ⚠️ All APIs failed, using fallback.');
    const detectedLang = localNLP.detectLanguage(message);
    const fallback = localNLP.getFallbackResponse(message, detectedLang);
    return res.json({ success: true, response: fallback });

  } catch (error) {
    console.error("[Ambience AI] Chat error:", error);
    return res.status(500).json({ 
      success: false, 
      error: "An error occurred while communicating with the AI assistant." 
    });
  }
};

async function tryGroq(systemPrompt, message, history) {
  try {
    if (!process.env.GROQ_API_KEY) return null;
    
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message }
    ];

    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 512,
      response_format: { type: 'json_object' }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 8000
    });

    const content = response.data.choices[0].message.content;
    return JSON.parse(content);
  } catch (err) {
    console.error("[Groq Fallback Error]", err.message);
    return null;
  }
}

async function tryGemini(systemPrompt, message, history) {
  try {
    if (!process.env.GEMINI_API_KEY) return null;
    
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: systemPrompt,
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.75,
        topP: 0.9,
        maxOutputTokens: 512
      }
    });

    const geminiHistory = history.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.content }]
    }));

    const chatSession = model.startChat({ history: geminiHistory });
    const result = await chatSession.sendMessage(message);
    return JSON.parse(result.response.text());
  } catch (err) {
    console.error("[Gemini Fallback Error]", err.message);
    return null;
  }
}

async function tryCloudflare(systemPrompt, message, history) {
  try {
    if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_AI_TOKEN) return null;
    
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: message }
    ];

    const response = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.1-8b-instruct`,
      { messages, temperature: 0.7, top_p: 0.9, max_tokens: 512 },
      {
        headers: {
          'Authorization': `Bearer ${process.env.CLOUDFLARE_AI_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );

    let content = response.data.result.response;
    
    // Cloudflare might wrap in markdown blocks, cleanup:
    if (content.includes('```json')) {
      content = content.split('```json')[1].split('```')[0].trim();
    }
    
    return JSON.parse(content);
  } catch (err) {
    console.error("[Cloudflare Fallback Error]", err.message);
    return null;
  }
}

exports.getTTSConfig = async (req, res) => {
  try {
    const { text, lang = 'en-US', voiceProfile = 'neutral', speed = 1.0, pitch = 1.0 } = req.body;

    if (!text) {
      return res.status(400).json({ success: false, error: "Text is required for TTS." });
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
        break;
    }

    console.log(`[Ambience AI] 🗣️ TTS config requested for profile: ${voiceProfile}`);

    return res.status(200).json({
      success: true,
      voiceConfig: { lang, rate, pitch: finalPitch, volume: 1.0, preferredVoiceKeywords }
    });
  } catch (error) {
    console.error("[Ambience AI] TTS config error:", error);
    return res.status(500).json({ 
      success: false, 
      error: "An error occurred while generating TTS configuration." 
    });
  }
};
