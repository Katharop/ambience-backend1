// ══════════════════════════════════════════════════════════════════════════════
// GEMINI NATIVE FUNCTION DECLARATIONS — PROJECT SENTIENCE
// ══════════════════════════════════════════════════════════════════════════════
// These function declarations are passed to Gemini's `tools` parameter,
// enabling native function calling. The LLM decides WHICH function to call
// based on user intent, and the API guarantees valid structured output.
//
// This replaces the old approach of asking the LLM to output JSON text.
// ══════════════════════════════════════════════════════════════════════════════

const functionDeclarations = [
  // ── NAVIGATION ──────────────────────────────────────────────────────────────
  {
    name: "navigateTo",
    description: `Navigate the user to a specific page on the Ambience website.

VALID ROUTES (use exact strings):
  "/" → Home page
  "/shop" → Shop (all products)
  "/shop/mens" → Men's fashion
  "/shop/womens" → Women's fashion
  "/shop/electronics" → Electronics (phones, laptops, tablets, gadgets)
  "/shop/footwear" → Footwear (shoes, sneakers, boots, sandals)
  "/shop/timepieces" → Timepieces (watches, smartwatches)
  "/shop/fragrances" → Fragrances (perfumes, cologne, body mist)
  "/shop/cosmetics" → Cosmetics (makeup, skincare, beauty)
  "/shop/accessories" → Accessories (bags, wallets, jewelry, belts, sunglasses)
  "/cart" → Shopping cart
  "/checkout" → Checkout / payment page
  "/orders" → Order history / tracking
  "/deals" → Deals, promotions, flash sales
  "/categories" → Category directory
  "/profile" → User profile
  "/settings" → Account settings & preferences

MULTILINGUAL TRIGGER EXAMPLES:
  "shop page" / "ஷாப் பேஜ்" / "சாப்ட் பேஜ்" / "शॉप पेज" / "கடைக்கு போ" → "/shop"
  "cart-la po" / "கார்ட்" / "कार्ट" → "/cart"
  "go home" / "ஹோம் பேஜ்" / "होम पेज" → "/"
  "men's page" / "ஆண்கள் பேஜ்" → "/shop/mens"

CRITICAL: If user says anything containing "page"/"பேஜ்"/"पेज" + a location name, it is ALWAYS navigation, NEVER a product search. "shop page" = navigate to /shop, NOT search for shirts.`,
    parameters: {
      type: "OBJECT",
      properties: {
        route: {
          type: "STRING",
          description: "The exact route path from the valid routes list above. Must start with '/'."
        }
      },
      required: ["route"]
    }
  },

  // ── PRODUCT SEARCH ──────────────────────────────────────────────────────────
  {
    name: "searchProducts",
    description: `Search for products by category, type, or keyword. This hijacks the website's search bar — same as if the user typed into it.

Use for BROAD/CATEGORY queries like "show me phones", "I want shoes", "laptop காட்டு".

The query MUST always be in English, regardless of conversation language.

PRODUCT TYPE MAPPING (user intent → query):
  phone/mobile/ஃபோன்/மொபைல்/फोन/मोबाइल/செல்/கைப்பேசி → "phone"
  laptop/லேப்டாப்/லேப்/लैपटॉप/labdop/labtop → "laptop"
  shoes/ஷூ/காலணி/செருப்பு/जूते/sneakers/kicks → "shoes"
  shirt/சட்டை/சொக்கா/शर्ट/tshirt/tee → "shirt"
  watch/வாட்ச்/கடிகாரம்/घड़ी → "watch"
  perfume/செண்ட்/அத்தர்/इत्र → "perfume"
  bag/பை/பேக்/बैग → "bag"
  cosmetics/மேக்கப்/मेकअप → "cosmetics"
  headphones/ஹெட்ஃபோன்/हेडफोन/airpods → "headphones"

DO NOT use this for specific products (use viewProduct instead).
DO NOT use this when user says "go to shop" — that's navigation, not search.`,
    parameters: {
      type: "OBJECT",
      properties: {
        query: {
          type: "STRING",
          description: "Search query in English. E.g. 'laptop', 'phone', 'shoes', 'shirt'"
        }
      },
      required: ["query"]
    }
  },

  // ── VIEW SPECIFIC PRODUCT ──────────────────────────────────────────────────
  {
    name: "viewProduct",
    description: `Navigate directly to a specific product's detail page. Use when the user asks for a SPECIFIC product by name, brand, model, or color — NOT for category browsing.

Examples: "show me the Samsung Galaxy S24" / "open the black Nike shoes" / "அந்த iPhone பாக்கணும்"

The productId MUST be the exact MongoDB _id from the injected product inventory.`,
    parameters: {
      type: "OBJECT",
      properties: {
        productId: {
          type: "STRING",
          description: "The exact MongoDB _id of the product from the live inventory."
        }
      },
      required: ["productId"]
    }
  },

  // ── VIEW PRODUCT BY SCREEN POSITION ────────────────────────────────────────
  {
    name: "viewProductByIndex",
    description: `Open a product by its visual position on the user's screen. Uses 0-based indexing from the currentlyVisibleProducts list.

POSITIONAL MAPPING:
  "first one" / "முதலாவது" / "पहला" / "1st" / "top one" → index: 0
  "second" / "இரண்டாவது" / "दूसरा" / "2nd" → index: 1
  "third" / "மூன்றாவது" / "तीसरा" / "3rd" → index: 2
  "fourth" / "நான்காவது" / "चौथा" / "4th" → index: 3
  "last one" / "கடைசி" / "आखिरी" → last index

Also supports descriptive references:
  "the red one" → match by color
  "the Nike one" → match by brand
  "the cheapest" → match by price

Use the exact product _id from the currentlyVisibleProducts array.`,
    parameters: {
      type: "OBJECT",
      properties: {
        index: {
          type: "INTEGER",
          description: "0-based index of the product in the currently visible products list."
        }
      },
      required: ["index"]
    }
  },

  // ── ADD TO CART ─────────────────────────────────────────────────────────────
  {
    name: "addToCart",
    description: `Add a product to the user's shopping cart.

Use productId = "current" when user says "add this" / "cart-la podu" / "இதை கார்ட்ல போடு" / "कार्ट में डालो" while on a product detail page.

Use exact MongoDB _id when adding a specific product discussed in conversation.

CRITICAL: You can NEVER process payments. After adding to cart, tell the user to go to checkout to complete the purchase.

MANDATORY UPSELL: After every ADD_TO_CART, suggest a complementary product:
  Shirt → belt, watch, pants
  Phone → case, earbuds, screen protector
  Shoes → socks, shoe cleaner
  Laptop → laptop bag, mouse
  Perfume → deodorant, body lotion`,
    parameters: {
      type: "OBJECT",
      properties: {
        productId: {
          type: "STRING",
          description: "MongoDB _id of the product, or 'current' for the product on the current page."
        }
      },
      required: ["productId"]
    }
  },

  // ── FILTER BY CATEGORY WITH EXACT IDS ──────────────────────────────────────
  {
    name: "filterByCategory",
    description: `Filter products on the shop page using specific product IDs from the inventory. Use when you want to show ONLY specific products that match a category/type from the database.

More precise than searchProducts — use this when you've identified exact matching products from the inventory.`,
    parameters: {
      type: "OBJECT",
      properties: {
        category: {
          type: "STRING",
          description: "Human-friendly category name (e.g. 'Mobile Phones', 'Laptops', 'Running Shoes')"
        },
        productIds: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "Array of exact MongoDB _id strings of matching products from inventory."
        },
        searchQuery: {
          type: "STRING",
          description: "English search term for the URL filter (e.g. 'phone', 'laptop', 'shoes')."
        }
      },
      required: ["category", "productIds"]
    }
  },

  // ── FILTER BY BUDGET ───────────────────────────────────────────────────────
  {
    name: "filterByBudget",
    description: `Filter products within a price budget. Use when user specifies a price constraint like "under 20000" / "₹10,000 க்கு கீழ" / "10000 से कम".

You MUST check the price field in the inventory and ONLY include products where price <= maxPrice.
If no products match the budget, inform the user warmly and suggest a higher range.

If only 1 product matches, call viewProduct instead for instant precision routing.`,
    parameters: {
      type: "OBJECT",
      properties: {
        maxPrice: {
          type: "NUMBER",
          description: "Maximum price in INR (rupees). E.g. 20000, 50000, 10000."
        },
        category: {
          type: "STRING",
          description: "Product type being filtered (e.g. 'phone', 'laptop', 'shoes')."
        },
        productIds: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "Array of MongoDB _id strings of products matching BOTH the category AND the budget."
        }
      },
      required: ["maxPrice", "category", "productIds"]
    }
  },

  // ── SORT PRODUCTS ──────────────────────────────────────────────────────────
  {
    name: "sortProducts",
    description: `Sort the current product listing on the page. Use when user says "sort by price" / "cheapest first" / "விலை குறைவு முதல்" / "सस्ता पहले".`,
    parameters: {
      type: "OBJECT",
      properties: {
        sortBy: {
          type: "STRING",
          enum: ["price-asc", "price-desc", "name", "newest"],
          description: "Sort order. 'price-asc' = cheapest first, 'price-desc' = expensive first, 'name' = A-Z, 'newest' = latest."
        }
      },
      required: ["sortBy"]
    }
  },

  // ── SCROLL PAGE ────────────────────────────────────────────────────────────
  {
    name: "scrollPage",
    description: `Scroll the page up or down. Use when user says "scroll down" / "கீழே போ" / "नीचे जाओ" / "go to top" / "scroll pannu".`,
    parameters: {
      type: "OBJECT",
      properties: {
        direction: {
          type: "STRING",
          enum: ["up", "down", "top", "bottom"],
          description: "'up' = scroll up, 'down' = scroll down, 'top' = jump to page top, 'bottom' = jump to page bottom."
        }
      },
      required: ["direction"]
    }
  },

  // ── GO TO CHECKOUT ─────────────────────────────────────────────────────────
  {
    name: "goToCheckout",
    description: `Navigate to the checkout/payment page. Use when user says "buy this" / "let's checkout" / "செக்அவுட்" / "खरीदो" / "purchase" / "pay". NEVER process actual payments — just navigate to checkout.`,
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  },

  // ── GO BACK ────────────────────────────────────────────────────────────────
  {
    name: "goBack",
    description: `Go to the previous page (browser back). Use when user says "go back" / "previous" / "பின்னால போ" / "back-ku po" / "पीछे जाओ" / "back போ".`,
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  },

  // ── SLEEP / DISMISS ────────────────────────────────────────────────────────
  {
    name: "sleepAssistant",
    description: `Close/minimize the AI assistant and enter passive wake-word mode. Use when user says "close" / "stop" / "bye" / "போயிடு" / "நிறுத்து" / "बंद करो" / "shut up" / "go to sleep" / "goodbye" / "dismiss" / "stop listening".`,
    parameters: {
      type: "OBJECT",
      properties: {},
      required: []
    }
  }
];

// ══════════════════════════════════════════════════════════════════════════════
// FUNCTION CALL → FRONTEND ACTION MAPPER
// ══════════════════════════════════════════════════════════════════════════════
// Maps Gemini's native function call responses to the existing frontend
// action format that AIContext.js and Smartvoiceassistant.js already understand.

function mapFunctionCallToAction(functionCall) {
  const { name, args } = functionCall;

  switch (name) {
    case "navigateTo":
      return { action: "NAVIGATE_ROUTE", path: args.route };

    case "searchProducts":
      return { action: "GLOBAL_SEARCH", query: args.query };

    case "viewProduct":
      return { action: "NAVIGATE_DETAIL", productId: args.productId };

    case "viewProductByIndex":
      return { action: "NAVIGATE_DETAIL_BY_INDEX", index: args.index };

    case "addToCart":
      return { action: "ADD_TO_CART", productId: args.productId };

    case "filterByCategory":
      return {
        action: "FILTER_CATEGORY",
        searchQuery: args.searchQuery || args.category,
        matchedProductIds: args.productIds
      };

    case "filterByBudget":
      return {
        action: "FILTER_DYNAMIC",
        matchedProductIds: args.productIds,
        inferredCategory: args.category,
        searchQuery: args.category,
        maxBudget: args.maxPrice
      };

    case "sortProducts":
      return { action: "SORT_PRODUCTS", sortBy: args.sortBy };

    case "scrollPage":
      return { action: "SCROLL", direction: args.direction };

    case "goToCheckout":
      return { action: "GO_TO_CHECKOUT" };

    case "goBack":
      return { action: "NAVIGATE_BACK" };

    case "sleepAssistant":
      return { action: "SLEEP" };

    default:
      console.warn(`[FunctionDeclarations] Unknown function call: ${name}`);
      return null;
  }
}

module.exports = {
  functionDeclarations,
  mapFunctionCallToAction
};
