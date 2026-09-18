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
  
  return 'english';
}

// 2. Classify intent
function classifyIntent(text) {
  const patterns = {
    GREETING: /\b(hi|hello|namaste|vanakkam|namaskaram|hai|helo|hey|yo|sup)\b/i,
    ORDER_STATUS: /where's my order|track order|मेरा आर्डर कहाँ है|என் ஆர்டர் எங்கே|എന്റെ ഓർഡർ എവിടെ|where is my order|order status/i,
    PRODUCT_SEARCH: /show me|find|दिखाओ|காட்டு|കാണിക്കൂ|i want|looking for|search|வேணும்|give me|get me/i,
    CART_ACTION: /add to cart|show cart|remove from cart|कार्ट में डालो|checkout|clear cart/i,
    FAQ: /return policy|shipping time|contact|payment methods|refund|delivery time|policy/i,
    PRICE_FILTER: /under \d+|below \d+|cheap|expensive|से कम|सस्ता|महंगा|വിലകുറഞ്ഞ/i,
    COMPARISON: /compare|which is better|difference between/i,
    NAVIGATE: /go to|take me|open|navigate|போ|திற|जाओ|खोलो|shop page|cart page/i,
    THANKS: /thank you|धन्यवाद|நன்றி|നന്ദி|thanks|shukriya/i,
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

  const categories = ['shirts', 'shoes', 'watches', 'bags', 'perfumes', 'electronics', 'cosmetics', 'laptop', 'phone'];
  const colors = { red: 'red', blue: 'blue', black: 'black', white: 'white', 'லாल்': 'red', 'काला': 'black', 'நீலம்': 'blue', 'ചുவപ്പ്': 'red' };
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

// 4. Warm, human-like response templates
const responses = {
  english: {
    GREETING: "Hey! Welcome to Ambience! What are you in the mood to explore today?",
    THANKS: "Anytime! Hit me up if you need anything else.",
    GOODBYE: "Catch you later! Happy shopping! ✌️",
    HELP: "I can help you find products, track orders, navigate the store, and answer any questions. Just ask!",
    FAQ_RETURN: "Easy peasy — we've got a 30-day returns policy. No drama.",
    FAQ_SHIPPING: "Free shipping on orders above ₹999! Usually arrives in 3-5 business days.",
    FAQ_PAYMENT: "We've got you covered — COD, UPI, Cards, and Net Banking all work.",
    FAQ_CONTACT: "Drop us a line at support@ambience.com — we're super responsive!",
    ORDER_FOUND: "Found your latest order! Here's the status.",
    ORDER_NOT_FOUND: "Hmm, I don't see any recent orders on your account.",
    PRODUCT_FOUND: "Ooh, check these out — I think you'll love them!",
    PRODUCT_NOT_FOUND: "Couldn't find an exact match, but let me know more and I'll dig deeper!"
  },
  hindi: {
    GREETING: "हेलो! Ambience में आपका स्वागत है! आज कुछ खास ढूंढ रहे हो?",
    THANKS: "कोई बात नहीं! और कुछ चाहिए तो बोलो!",
    GOODBYE: "बाय! Happy shopping! ✌️",
    HELP: "मैं प्रोडक्ट्स ढूंढने, ऑर्डर ट्रैक करने, और सवालों के जवाब देने में हेल्प कर सकता हूँ।",
    FAQ_RETURN: "30 दिन की आसान रिटर्न पॉलिसी है — कोई झंझट नहीं।",
    FAQ_SHIPPING: "₹999 से ऊपर फ्री शिपिंग! 3-5 दिन में मिल जाता है।",
    FAQ_PAYMENT: "COD, UPI, Cards, Net Banking — सब चलता है!",
    FAQ_CONTACT: "support@ambience.com पर मैसेज करो — जल्दी रिप्लाई आएगा!",
    ORDER_FOUND: "तुम्हारा लेटेस्ट ऑर्डर मिल गया! ये रहा स्टेटस।",
    ORDER_NOT_FOUND: "हम्म, तुम्हारे अकाउंट पर कोई रीसेंट ऑर्डर नहीं दिख रहा।",
    PRODUCT_FOUND: "ये देखो — मुझे लगता है ये तुम्हें पसंद आएंगे!",
    PRODUCT_NOT_FOUND: "एक्जैक्ट मैच नहीं मिला, लेकिन और बताओ तो और ढूंढता हूँ!"
  },
  malayalam: {
    GREETING: "ഹായ്! ആംബിയൻസിലേക്ക് സ്വാഗതം! ഇന്ന് എന്താ നോക്കുന്നത്?",
    THANKS: "എപ്പോഴും! വേറെ എന്തെങ്കിലും വേണേൽ പറ!",
    GOODBYE: "ബൈ! Happy shopping! ✌️",
    HELP: "ഉൽപ്പന്നങ്ങൾ കണ്ടെത്താനും ഓർഡറുകൾ ട്രാക്ക് ചെയ്യാനും ചോദ്യങ്ങൾക്ക് ഉത്തരം നൽകാനും എനിക്ക് കഴിയും.",
    FAQ_RETURN: "30 ദിവസത്തെ ഈസി റിട്ടേൺ പോളിസി ഉണ്ട് — ടെൻഷൻ വേണ്ട.",
    FAQ_SHIPPING: "₹999-ന് മുകളിൽ ഫ്രീ ഷിപ്പിംഗ്! 3-5 ദിവസത്തിനുള്ളിൽ കിട്ടും.",
    FAQ_PAYMENT: "COD, UPI, Cards, Net Banking — എല്ലാം ആക്സെപ്റ്റ് ചെയ്യും.",
    FAQ_CONTACT: "support@ambience.com-ലേക്ക് മെസ്സേജ് അയയ്ക്കൂ — ക്വിക്ക് റിപ്ലൈ ഉറപ്പ്!",
    ORDER_FOUND: "നിന്റെ ലേറ്റസ്റ്റ് ഓർഡർ കണ്ടെത്തി! ഇതാ സ്റ്റാറ്റസ്.",
    ORDER_NOT_FOUND: "ഹ്മ്മ്, നിന്റെ അക്കൗണ്ടിൽ റീസെന്റ് ഓർഡറുകളൊന്നും കാണുന്നില്ല.",
    PRODUCT_FOUND: "ഇതൊന്ന് നോക്ക് — ഇഷ്ടപ്പെടും എന്ന് എനിക്ക് ഉറപ്പാണ്!",
    PRODUCT_NOT_FOUND: "എക്സാക്ട്ട് മാച്ച് കിട്ടിയില്ല, പക്ഷേ കൂടുതൽ പറഞ്ഞാൽ ഞാൻ ഇനിയും തിരയാം!"
  },
  tamil: {
    GREETING: "ஹேய்! ஆம்பியன்ஸுக்கு வரவேற்கிறோம்! இன்னைக்கு என்ன பாக்கணும்?",
    THANKS: "எப்பவும்! வேற ஏதாவது வேணும்னா சொல்லுங்க!",
    GOODBYE: "பை! Happy shopping! ✌️",
    HELP: "ப்ராடக்ட்ஸ் தேட, ஆர்டர் ட்ராக் பண்ண, எந்த கேள்விக்கும் பதில் சொல்ல நான் ரெடி!",
    FAQ_RETURN: "30 நாள் ஈஸி ரிட்டர்ன் பாலிசி இருக்கு — டென்ஷன் இல்ல.",
    FAQ_SHIPPING: "₹999 மேல இலவச ஷிப்பிங்! 3-5 நாளுல வந்துடும்.",
    FAQ_PAYMENT: "COD, UPI, Cards, Net Banking — எல்லாம் ஓகே!",
    FAQ_CONTACT: "support@ambience.com-ல மெசேஜ் பண்ணுங்க — சீக்கிரமே ரிப்ளை வரும்!",
    ORDER_FOUND: "உங்க லேட்டஸ்ட் ஆர்டர் கிடைச்சது! ஸ்டேட்டஸ் இதோ.",
    ORDER_NOT_FOUND: "ஹ்ம்ம், உங்க அக்கவுண்ட்ல ரீசென்ட் ஆர்டர் எதுவும் இல்ல.",
    PRODUCT_FOUND: "இத பாருங்க — உங்களுக்கு பிடிக்கும்னு நினைக்கிறேன்!",
    PRODUCT_NOT_FOUND: "எக்ஸாக்ட் மேட்ச் கிடைக்கல, ஆனா இன்னும் சொன்னா தேடறேன்!"
  }
};

exports.processLocally = async (message, user, recentOrders, conversationHistory = []) => {
  try {
    const text = message.toLowerCase();
    const lang = detectLanguage(message);
    const intent = classifyIntent(text);
    
    const langResponses = responses[lang] || responses['english'];

    const responseTemplate = {
      text: "",
      actions: [],
      emotion: "neutral",
      suggestedProducts: [],
      language: lang,
      handledLocally: true
    };

    // ONLY handle trivial social intents locally.
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

    // Everything else goes to the LLM waterfall.
    return null;

  } catch (error) {
    console.error("[Local NLP] Error processing:", error);
    return null;
  }
};

// Smart fallback — NEVER shows connectivity errors
exports.getFallbackResponse = (message, lang) => {
  const langResponses = responses[lang] || responses['english'];
  const fallbacks = {
    english: "I'm thinking about this one — could you rephrase that a bit? I want to give you the best answer!",
    tamil: "ஒரு நிமிஷம் — இன்னொரு தடவை கேளுங்க, சரியா பதில் சொல்றேன்!",
    malayalam: "ഒരു നിമിഷം — ഒന്നുകൂടി ചോദിക്കൂ, നല്ല ഉത്തരം തരാം!",
    hindi: "एक सेकंड — दोबारा पूछो, बेस्ट जवाब दूँगा!"
  };
  return {
    text: fallbacks[lang] || fallbacks.english,
    actions: [],
    emotion: "thinking",
    suggestedProducts: [],
    language: lang,
    handledLocally: true
  };
};

exports.detectLanguage = detectLanguage;
