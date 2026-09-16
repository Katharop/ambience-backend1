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

    // Determine if query is product-related to fetch catalog
    const productKeywords = ['product', 'shop', 'buy', 'price', 'recommend', 'show', 'compare', 'looking for', 'shirt', 'shoe', 'watch', 'bag'];
    const isProductQuery = productKeywords.some(keyword => message.toLowerCase().includes(keyword));
    
    let catalogContext = '';
    if (isProductQuery) {
      const products = await Product.find({ status: 'live' })
        .select('name brand category retailPrice dealPrice description tags _id imageUrl')
        .limit(20)
        .lean();
      catalogContext = `\n\nLive Product Catalog (Top 20 items):\n${JSON.stringify(products)}`;
    }

    const systemPrompt = `You are 'Ambience AI' — a premium shopping concierge for the Ambience luxury e-commerce platform.

INTERACTION RULES:
1. ALWAYS respond in the SAME language the user speaks. If Tamil → respond in Tamil. Malayalam → Malayalam. Hindi → Hindi. English → English. Detect the language from the user's message.
2. You speak Malayalam (Kerala), Tamil, Hindi, Hinglish, and English fluently and naturally.
3. Keep responses CONCISE — maximum 2-3 short sentences. Your text is read aloud via text-to-speech, so avoid long paragraphs, bullet lists, or technical jargon.
4. ASK follow-up questions to understand exactly what the user wants before showing products:
   - If they ask for "a laptop", ask: "What's your budget? Any brand preference?"
   - If they ask for "shoes", ask: "For men or women? Casual or formal?"
   - If they ask for "a gift", ask: "Who is it for? What's the occasion?"
   - Do NOT dump all products at once — have a natural conversation first.
5. Be warm, personal, and human-like. Use the user's name when you know it. Sound like a knowledgeable friend, not a corporate bot.
6. When recommending products, briefly explain WHY each one suits the user's needs.
7. ONLY access the authenticated user's data provided below.
8. User's preferred language: ${language || 'en-US'}
9. User's selected character: ${character || 'boy'}
10. Personality: ${personality ? JSON.stringify(personality) : 'default'}

RESPONSE FORMAT (strict JSON — no markdown, no extra text outside this JSON):
{
  "text": "Your concise, natural response here",
  "actions": [
    { "type": "NAVIGATE", "path": "/product/xxx" },
    { "type": "ADD_TO_CART", "productId": "xxx" },
    { "type": "SHOW_PRODUCTS", "products": ["id1", "id2"] }
  ],
  "emotion": "happy|thinking|excited|neutral|empathetic",
  "suggestedProducts": [],
  "language": "detected-language-code"
}

--- USER CONTEXT ---
User: ${user ? user.name || 'Guest' : 'Guest'}
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
      response_format: { type: 'json_object' }
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 5000
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
      generationConfig: { responseMimeType: "application/json" }
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
      { messages },
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
