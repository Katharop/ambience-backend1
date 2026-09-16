const { GoogleGenerativeAI } = require('@google/generative-ai');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');

// Initialize Gemini
// Fallback if GEMINI_API_KEY is not set is handled in the controller methods
let genAI = null;
if (process.env.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
}

exports.chat = async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({
        success: false,
        error: "AI service is currently unavailable (API key not configured)."
      });
    }

    if (!genAI) {
      genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    }

    const { message, conversationHistory = [], currentPage, cartItems = [] } = req.body;
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
    // We fetch a lightweight catalog of live products to pass to the model
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

    const systemPrompt = `You are 'Ambience AI' — a premium shopping assistant for the Ambience luxury e-commerce platform.
Your capabilities: product search, recommendations, comparisons, order tracking, cart management, and navigation.
CRITICAL RULES:
1. ONLY access and reference the authenticated user's own data (provided in the context below).
2. Respond in the same language the user speaks.
3. Be warm, knowledgeable, proactive, and maintain a premium, luxury tone.
4. You MUST return your response as a valid JSON object EXACTLY matching this structure:
{
  "text": "Your natural language response here",
  "actions": [
    { "type": "NAVIGATE", "path": "/product/xxx" },
    { "type": "ADD_TO_CART", "productId": "xxx" },
    { "type": "SHOW_PRODUCTS", "products": ["productId1", "productId2"] }
  ],
  "emotion": "happy|thinking|excited|neutral|empathetic",
  "suggestedProducts": ["productId1", "productId2"]
}
(The actions and suggestedProducts arrays can be empty if not applicable).

--- USER CONTEXT ---
User Profile: ${JSON.stringify(user)}
Recent Orders: ${JSON.stringify(recentOrders)}
Current Cart: ${JSON.stringify(cartItems)}
Current Page: ${currentPage || 'unknown'}
${catalogContext}
`;

    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: systemPrompt,
      generationConfig: {
        responseMimeType: "application/json",
      }
    });

    // Format history for Gemini
    const formattedHistory = conversationHistory.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }]
    }));

    const chatSession = model.startChat({
      history: formattedHistory,
    });

    const result = await chatSession.sendMessage(message);
    const responseText = result.response.text();
    
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(responseText);
    } catch (e) {
      console.error("[Ambience AI] Failed to parse JSON from Gemini:", responseText);
      // Fallback response if JSON parsing fails
      parsedResponse = {
        text: responseText,
        actions: [],
        emotion: "neutral",
        suggestedProducts: []
      };
    }

    console.log(`[Ambience AI] 🤖 Chat processed for user ${user.email}`);
    
    return res.status(200).json({
      success: true,
      response: {
        text: parsedResponse.text || "",
        actions: Array.isArray(parsedResponse.actions) ? parsedResponse.actions : [],
        emotion: parsedResponse.emotion || "neutral",
        suggestedProducts: Array.isArray(parsedResponse.suggestedProducts) ? parsedResponse.suggestedProducts : [],
        language: "auto" // Could be enhanced to detect language
      }
    });

  } catch (error) {
    console.error("[Ambience AI] Chat error:", error);
    return res.status(500).json({ 
      success: false, 
      error: "An error occurred while communicating with the AI assistant." 
    });
  }
};

exports.getTTSConfig = async (req, res) => {
  try {
    const { text, lang = 'en-US', voiceProfile = 'neutral', speed = 1.0, pitch = 1.0 } = req.body;

    if (!text) {
      return res.status(400).json({ success: false, error: "Text is required for TTS." });
    }

    // Determine voice configuration based on profile
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
      voiceConfig: {
        lang,
        rate,
        pitch: finalPitch,
        volume: 1.0,
        preferredVoiceKeywords
      }
    });
  } catch (error) {
    console.error("[Ambience AI] TTS config error:", error);
    return res.status(500).json({ 
      success: false, 
      error: "An error occurred while generating TTS configuration." 
    });
  }
};
