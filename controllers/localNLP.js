const Product = require('../models/Product');
const Order = require('../models/Order');

// 1. Detect language
function detectLanguage(message) {
  const text = message.toLowerCase();
  
  const malayalamPattern = /[\u0D00-\u0D7F]/;
  const tamilPattern = /[\u0B80-\u0BFF]/;
  const hindiPattern = /[\u0900-\u097F]/;
  
  if (malayalamPattern.test(text) || text.match(/\b(namaskaram|enthokkeyundu|nandi|sughamano)\b/)) return 'malayalam';
  if (tamilPattern.test(text) || text.match(/\b(vanakkam|nandri|eppadi|irukkinga)\b/)) return 'tamil';
  if (hindiPattern.test(text) || text.match(/\b(namaste|shukriya|kya|hai|kaha)\b/)) return 'hindi';
  if (text.match(/\b(hi|hello|hey|thanks|bye|what|where|show|find|add)\b/)) return 'english';
  
  return 'english'; // Default
}

// 2. Classify intent
function classifyIntent(text) {
  const patterns = {
    GREETING: /hi|hello|namaste|vanakkam|namaskaram|hai|helo/i,
    ORDER_STATUS: /where's my order|track order|मेरा आर्डर कहाँ है|என் ஆர்டர் எங்கே|എന്റെ ഓർഡർ എവിടെ|where is my order|order status/i,
    PRODUCT_SEARCH: /show me|find|दिखाओ|காட்டு|കാണിക്കൂ|i want|looking for|search/i,
    CART_ACTION: /add to cart|show cart|remove from cart|कार्ट में डालो|checkout|clear cart/i,
    FAQ: /return policy|shipping time|contact|payment methods|refund|delivery time|policy/i,
    PRICE_FILTER: /under \d+|below \d+|cheap|expensive|से कम|सस्ता|महंगा|വിലകുറഞ്ഞ/i,
    COMPARISON: /compare|which is better|difference between/i,
    THANKS: /thank you|धन्यवाद|நன்றி|നന്ദി|thanks|shukriya/i,
    GOODBYE: /bye|goodbye|alvida|போய் வருகிறேன்|പോകുന്നു/i,
    HELP: /help|what can you do|how does this work|सहायता|உதவி|സഹായം/i
  };

  for (const [intent, regex] of Object.entries(patterns)) {
    if (regex.test(text)) return intent;
  }
  return 'UNKNOWN';
}

// 3. Extract entities
function extractEntities(text) {
  const entities = {
    category: null,
    maxPrice: null,
    color: null,
    gender: null,
    brand: null
  };

  const categories = ['shirts', 'shoes', 'watches', 'bags', 'perfumes', 'electronics', 'cosmetics'];
  const colors = { red: 'red', blue: 'blue', black: 'black', white: 'white', 'लाल': 'red', 'काला': 'black', 'நீலம்': 'blue', 'ചുവപ്പ്': 'red' };
  const genders = { men: 'men', women: 'women', kids: 'kids', 'पुरुष': 'men', 'महिला': 'women' };

  for (const cat of categories) {
    if (text.toLowerCase().includes(cat)) entities.category = cat;
  }

  for (const [key, val] of Object.entries(colors)) {
    if (text.toLowerCase().includes(key)) entities.color = val;
  }

  for (const [key, val] of Object.entries(genders)) {
    if (text.toLowerCase().includes(key)) entities.gender = val;
  }

  const priceMatch = text.match(/(?:under|below) (?:₹|rs\.?|rupees )?(\d+)/i) || text.match(/(\d+) (?:से कम)/);
  if (priceMatch) entities.maxPrice = parseInt(priceMatch[1], 10);

  return entities;
}

// 4 & 7. Generate responses and FAQ knowledge base
const responses = {
  english: {
    GREETING: "Hello! Welcome to Ambience. How can I assist you today?",
    THANKS: "You're welcome! Let me know if you need anything else.",
    GOODBYE: "Goodbye! Have a great day.",
    HELP: "I can help you find products, track your orders, and answer questions about our policies.",
    FAQ_RETURN: "We have a 30-day easy returns policy.",
    FAQ_SHIPPING: "We offer free shipping above ₹999. It usually takes 3-5 business days.",
    FAQ_PAYMENT: "We accept COD, UPI, Cards, and Net Banking.",
    FAQ_CONTACT: "You can reach us at support@ambience.com.",
    ORDER_FOUND: "Here is your latest order status.",
    ORDER_NOT_FOUND: "I couldn't find any recent orders for you.",
    PRODUCT_FOUND: "Here are some products you might like.",
    PRODUCT_NOT_FOUND: "Sorry, I couldn't find any products matching your criteria."
  },
  hindi: {
    GREETING: "नमस्ते! Ambience में आपका स्वागत है। मैं आज आपकी कैसे सहायता कर सकता हूँ?",
    THANKS: "आपका स्वागत है! यदि आपको कुछ और चाहिए तो मुझे बताएं।",
    GOODBYE: "अलविदा! आपका दिन शुभ हो।",
    HELP: "मैं आपको उत्पाद खोजने, आपके ऑर्डर को ट्रैक करने और हमारी नीतियों के बारे में सवालों के जवाब देने में मदद कर सकता हूं।",
    FAQ_RETURN: "हमारी 30-दिन की आसान रिटर्न पॉलिसी है।",
    FAQ_SHIPPING: "हम ₹999 से ऊपर मुफ्त शिपिंग प्रदान करते हैं। इसमें आमतौर पर 3-5 कार्यदिवस लगते हैं।",
    FAQ_PAYMENT: "हम COD, UPI, Cards और Net Banking स्वीकार करते हैं।",
    FAQ_CONTACT: "आप हमसे support@ambience.com पर संपर्क कर सकते हैं।",
    ORDER_FOUND: "यहां आपके नवीनतम ऑर्डर की स्थिति है।",
    ORDER_NOT_FOUND: "मुझे आपके लिए कोई हालिया ऑर्डर नहीं मिला।",
    PRODUCT_FOUND: "यहां कुछ उत्पाद दिए गए हैं जो आपको पसंद आ सकते हैं।",
    PRODUCT_NOT_FOUND: "क्षमा करें, मुझे आपके मानदंडों से मेल खाने वाले कोई उत्पाद नहीं मिले।"
  },
  malayalam: {
    GREETING: "നമസ്കാരം! ആംബിയൻസിലേക്ക് സ്വാഗതം. എനിക്ക് നിങ്ങളെ എങ്ങനെ സഹായിക്കാനാകും?",
    THANKS: "സ്വാഗതം! മറ്റെന്തെങ്കിലും വേണമെങ്കിൽ പറയുക.",
    GOODBYE: "വിട! നല്ലൊരു ദിവസം ആശംസിക്കുന്നു.",
    HELP: "ഉൽപ്പന്നങ്ങൾ കണ്ടെത്താനും ഓർഡറുകൾ ട്രാക്ക് ചെയ്യാനും സംശയങ്ങൾക്ക് മറുപടി നൽകാനും എനിക്ക് കഴിയും.",
    FAQ_RETURN: "ഞങ്ങൾക്ക് 30-ദിവസത്തെ എളുപ്പത്തിലുള്ള റിട്ടേൺ പോളിസി ഉണ്ട്.",
    FAQ_SHIPPING: "₹999-ന് മുകളിലുള്ള ഓർഡറുകൾക്ക് സൗജന്യ ഷിപ്പിംഗ്. 3-5 ദിവസങ്ങൾക്കുള്ളിൽ ലഭിക്കും.",
    FAQ_PAYMENT: "COD, UPI, Cards, Net Banking എന്നിവ സ്വീകരിക്കും.",
    FAQ_CONTACT: "support@ambience.com എന്ന വിലാസത്തിൽ ബന്ധപ്പെടുക.",
    ORDER_FOUND: "നിങ്ങളുടെ അവസാനത്തെ ഓർഡർ വിവരങ്ങൾ ഇതാ.",
    ORDER_NOT_FOUND: "നിങ്ങളുടെ പേരിലുള്ള പുതിയ ഓർഡറുകളൊന്നും കണ്ടെത്താനായില്ല.",
    PRODUCT_FOUND: "നിങ്ങൾക്ക് ഇഷ്ടപ്പെട്ടേക്കാവുന്ന ചില ഉൽപ്പന്നങ്ങൾ ഇതാ.",
    PRODUCT_NOT_FOUND: "നിങ്ങൾ തിരഞ്ഞ ഉൽപ്പന്നങ്ങൾ കണ്ടെത്താനായില്ല."
  },
  tamil: {
    GREETING: "வணக்கம்! ஆம்பியன்ஸ்க்கு உங்களை வரவேற்கிறோம். இன்று நான் உங்களுக்கு எப்படி உதவ முடியும்?",
    THANKS: "நன்றி! உங்களுக்கு வேறு ஏதாவது தேவைப்பட்டால் சொல்லுங்கள்.",
    GOODBYE: "போய் வருகிறேன்! இனிய நாளாக அமையட்டும்.",
    HELP: "தயாரிப்புகளைக் கண்டறியவும், ஆர்டர்களைக் கண்காணிக்கவும், எங்கள் கொள்கைகள் பற்றி அறியவும் நான் உதவ முடியும்.",
    FAQ_RETURN: "நாங்கள் 30-நாள் எளிதான திரும்பப் பெறும் கொள்கையைக் கொண்டுள்ளோம்.",
    FAQ_SHIPPING: "₹999 க்கு மேல் இலவச ஷிப்பிங் வழங்குகிறோம். இது பொதுவாக 3-5 வணிக நாட்கள் ஆகும்.",
    FAQ_PAYMENT: "நாங்கள் COD, UPI, Cards மற்றும் Net Banking ஐ ஏற்கிறோம்.",
    FAQ_CONTACT: "support@ambience.com இல் எங்களைத் தொடர்பு கொள்ளலாம்.",
    ORDER_FOUND: "உங்கள் சமீபத்திய ஆர்டர் நிலை இதோ.",
    ORDER_NOT_FOUND: "உங்களுக்கான சமீபத்திய ஆர்டர்கள் எதையும் என்னால் கண்டுபிடிக்க முடியவில்லை.",
    PRODUCT_FOUND: "நீங்கள் விரும்பக்கூடிய சில தயாரிப்புகள் இங்கே.",
    PRODUCT_NOT_FOUND: "மன்னிக்கவும், உங்கள் தேடலுக்குப் பொருந்தும் தயாரிப்புகள் எதுவும் இல்லை."
  }
};

exports.processLocally = async (message, user, recentOrders) => {
  try {
    const text = message.toLowerCase();
    const lang = detectLanguage(message);
    const intent = classifyIntent(text);
    
    // Fallback to english if language responses don't exist
    const langResponses = responses[lang] || responses['english'];

    const responseTemplate = {
      text: "",
      actions: [],
      emotion: "neutral",
      suggestedProducts: [],
      language: lang,
      handledLocally: true
    };

    if (intent === 'GREETING') {
      responseTemplate.text = langResponses.GREETING;
      responseTemplate.emotion = "happy";
      return responseTemplate;
    }

    if (intent === 'THANKS') {
      responseTemplate.text = langResponses.THANKS;
      responseTemplate.emotion = "happy";
      return responseTemplate;
    }

    if (intent === 'GOODBYE') {
      responseTemplate.text = langResponses.GOODBYE;
      return responseTemplate;
    }

    if (intent === 'HELP') {
      responseTemplate.text = langResponses.HELP;
      return responseTemplate;
    }

    if (intent === 'FAQ') {
      if (text.includes('return') || text.includes('refund')) {
        responseTemplate.text = langResponses.FAQ_RETURN;
      } else if (text.includes('shipping') || text.includes('delivery')) {
        responseTemplate.text = langResponses.FAQ_SHIPPING;
      } else if (text.includes('payment') || text.includes('pay')) {
        responseTemplate.text = langResponses.FAQ_PAYMENT;
      } else if (text.includes('contact') || text.includes('support')) {
        responseTemplate.text = langResponses.FAQ_CONTACT;
      } else {
        return null; // Let LLM handle complex FAQs
      }
      return responseTemplate;
    }

    if (intent === 'ORDER_STATUS') {
      if (recentOrders && recentOrders.length > 0) {
        responseTemplate.text = langResponses.ORDER_FOUND;
        responseTemplate.actions = [{ type: 'NAVIGATE', path: `/order/${recentOrders[0].orderId}` }];
      } else {
        responseTemplate.text = langResponses.ORDER_NOT_FOUND;
        responseTemplate.emotion = "empathetic";
      }
      return responseTemplate;
    }

    if (intent === 'PRODUCT_SEARCH' || intent === 'PRICE_FILTER') {
      const entities = extractEntities(text);
      
      const query = { status: 'live' };
      if (entities.category) query.category = new RegExp(entities.category, 'i');
      if (entities.gender) query.category = new RegExp(entities.gender, 'i'); // Simple mapped assumption
      if (entities.maxPrice) query.dealPrice = { $lte: entities.maxPrice };

      // If we didn't extract any meaningful entities, let LLM handle it
      if (!entities.category && !entities.gender && !entities.maxPrice && !entities.color) {
        return null; 
      }

      const products = await Product.find(query).limit(5).lean();
      
      if (products.length > 0) {
        responseTemplate.text = langResponses.PRODUCT_FOUND;
        responseTemplate.suggestedProducts = products.map(p => p._id.toString());
        responseTemplate.actions = [{ type: 'SHOW_PRODUCTS', products: products.map(p => p._id.toString()) }];
      } else {
        responseTemplate.text = langResponses.PRODUCT_NOT_FOUND;
        responseTemplate.emotion = "empathetic";
      }
      return responseTemplate;
    }

    // Unhandled intent or complex queries fallback to LLM
    return null;

  } catch (error) {
    console.error("[Local NLP] Error processing:", error);
    return null; // Fallback to LLM on error
  }
};

exports.getFallbackResponse = (message, lang) => {
  const langResponses = responses[lang] || responses['english'];
  return {
    text: "I'm having a little trouble connecting right now, but I'm still here to help! Please try again in a moment.",
    actions: [],
    emotion: "empathetic",
    suggestedProducts: [],
    language: lang,
    handledLocally: true
  };
};
