// ═══════════════════════════════════════════════════════════════════════════
// SUPLOOK SERVER v3.0
// Visual AI for Foodservice Distribution
// Analyzes restaurant photos to predict supply needs
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3009;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ═══════════════════════════════════════════════════════════════════════════
// AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════════════

const AUTH_KEY = process.env.AUTH_KEY || 'suplook-dev-key';
const ADMIN_KEY = process.env.ADMIN_KEY || 'suplook-admin-key';

const requireAuth = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.key;
  
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key. Add x-api-key header.' });
  }
  
  if (apiKey !== AUTH_KEY && apiKey !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  
  req.isAdmin = (apiKey === ADMIN_KEY);
  next();
};

const publicRoutes = ['/health', '/login'];

app.use((req, res, next) => {
  if (publicRoutes.includes(req.path)) {
    return next();
  }
  requireAuth(req, res, next);
});

app.post('/login', (req, res) => {
  const { key } = req.body;
  
  if (key === ADMIN_KEY) {
    return res.json({ success: true, level: 'admin', key: ADMIN_KEY });
  }
  
  if (key === AUTH_KEY) {
    return res.json({ success: true, level: 'user', key: AUTH_KEY });
  }
  
  res.status(401).json({ error: 'Invalid key' });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG & DATA
// ═══════════════════════════════════════════════════════════════════════════

const config = {
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  googleKey: process.env.GOOGLE_API_KEY,
  yelpKey: process.env.YELP_API_KEY
};

let anthropic = null;
if (config.anthropicKey) {
  anthropic = new Anthropic({ apiKey: config.anthropicKey });
  console.log('✅ Anthropic client initialized');
} else {
  console.warn('⚠️ ANTHROPIC_API_KEY not set - running in demo mode');
}

// Load product catalog
let productCatalog = null;
try {
  const catalogPath = path.join(__dirname, 'product_catalog.json');
  if (fs.existsSync(catalogPath)) {
    productCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    console.log('✅ Product catalog loaded');
  }
} catch (err) {
  console.error('Error loading catalog:', err.message);
}

// ═══════════════════════════════════════════════════════════════════════════
// CORRECTIONS DATABASE - THE MOAT
// Human corrections that make the AI smarter over time
// ═══════════════════════════════════════════════════════════════════════════

const correctionsFile = path.join(__dirname, 'corrections.json');
let corrections = { byName: {}, byCuisine: {}, byVisual: {} };

try {
  if (fs.existsSync(correctionsFile)) {
    corrections = JSON.parse(fs.readFileSync(correctionsFile, 'utf8'));
    console.log('✅ Corrections loaded:', Object.keys(corrections.byName).length, 'entries');
  }
} catch (err) {
  console.log('No existing corrections file');
}

const saveCorrections = () => {
  fs.writeFileSync(correctionsFile, JSON.stringify(corrections, null, 2));
};

// ═══════════════════════════════════════════════════════════════════════════
// PHOTO HUNTER
// Multi-source photo collection: Yelp > Instagram > Google Places
// ═══════════════════════════════════════════════════════════════════════════

const photoHunter = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5'
  },

  // Search Yelp using Fusion API
  async searchYelp(restaurantName, city) {
    const photos = [];
    let yelpData = null;
    
    if (!config.yelpKey) {
      return { photos, yelpData };
    }
    
    try {
      const searchUrl = `https://api.yelp.com/v3/businesses/search?term=${encodeURIComponent(restaurantName)}&location=${encodeURIComponent(city)}&limit=1`;
      
      const searchResp = await axios.get(searchUrl, {
        headers: { 'Authorization': `Bearer ${config.yelpKey}` },
        timeout: 10000
      });
      
      const business = searchResp.data.businesses?.[0];
      if (!business) return { photos, yelpData };
      
      const detailsUrl = `https://api.yelp.com/v3/businesses/${business.id}`;
      const detailsResp = await axios.get(detailsUrl, {
        headers: { 'Authorization': `Bearer ${config.yelpKey}` },
        timeout: 10000
      });
      
      const details = detailsResp.data;
      
      yelpData = {
        yelp_id: details.id,
        yelp_url: details.url,
        yelp_rating: details.rating,
        yelp_review_count: details.review_count,
        yelp_price: details.price,
        yelp_categories: details.categories?.map(c => c.title) || []
      };
      
      if (details.image_url) {
        photos.push({
          url: details.image_url.replace('/o.jpg', '/l.jpg'),
          source: 'yelp',
          type: 'main'
        });
      }
      
      if (details.photos && details.photos.length > 0) {
        for (const photoUrl of details.photos.slice(0, 5)) {
          if (!photos.find(p => p.url === photoUrl)) {
            photos.push({ url: photoUrl, source: 'yelp', type: 'gallery' });
          }
        }
      }
      
      console.log(`  📸 Yelp: Found ${photos.length} photos | ⭐ ${details.rating}`);
    } catch (err) {
      console.log(`  ⚠️ Yelp error: ${err.message}`);
    }
    return { photos, yelpData };
  },

  // Get Google Places photos
  async searchGooglePlaces(placeId, apiKey) {
    const photos = [];
    if (!placeId || !apiKey) return photos;
    
    try {
      const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=photos&key=${apiKey}`;
      const resp = await axios.get(detailsUrl, { timeout: 10000 });
      
      const placePhotos = resp.data.result?.photos || [];
      for (const photo of placePhotos.slice(0, 5)) {
        if (photo.photo_reference) {
          const photoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=${photo.photo_reference}&key=${apiKey}`;
          photos.push({ url: photoUrl, source: 'google_places', type: 'user' });
        }
      }
      
      console.log(`  📸 Google Places: Found ${photos.length} photos`);
    } catch (err) {
      console.log(`  ⚠️ Google Places error: ${err.message}`);
    }
    return photos;
  },

  // Main photo hunting function
  async huntPhotos(restaurant) {
    console.log(`\n🔍 Hunting photos for: ${restaurant.name}`);
    
    const allPhotos = [];
    let yelpData = null;
    const city = restaurant.city || 'New York';
    
    // 1. Yelp (best quality photos)
    const yelpResult = await this.searchYelp(restaurant.name, city);
    allPhotos.push(...yelpResult.photos);
    yelpData = yelpResult.yelpData;
    await this.delay(500);
    
    // 2. Google Places
    if (restaurant.place_id && config.googleKey) {
      const gpPhotos = await this.searchGooglePlaces(restaurant.place_id, config.googleKey);
      allPhotos.push(...gpPhotos);
    }
    
    // Prioritize: Yelp > Google
    const prioritized = allPhotos.sort((a, b) => {
      const priority = { yelp: 1, google_places: 2 };
      return (priority[a.source] || 3) - (priority[b.source] || 3);
    });
    
    console.log(`  ✅ Total: ${prioritized.length} photos collected`);
    
    return {
      photos: prioritized.slice(0, 10),
      photoTier: prioritized.some(p => p.source === 'yelp') ? 1 : 
                 prioritized.length > 0 ? 2 : 3,
      yelpData
    };
  },

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// LEADS STORAGE
// ═══════════════════════════════════════════════════════════════════════════

const leadsFile = path.join(__dirname, 'leads.json');
let leads = [];

try {
  if (fs.existsSync(leadsFile)) {
    leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
    console.log('✅ Leads loaded:', leads.length, 'total');
  }
} catch (err) {
  console.log('No existing leads file');
}

const saveLeads = () => {
  fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2));
};

// ═══════════════════════════════════════════════════════════════════════════
// VISION AI CORE
// ═══════════════════════════════════════════════════════════════════════════

function buildVisionPrompt() {
  const catalog = productCatalog || getInlineCatalog();
  
  let productList = '';
  for (const [catKey, cat] of Object.entries(catalog.categories)) {
    productList += `\n${cat.name}:\n`;
    for (const p of cat.products) {
      productList += `  - ${p.sku}: ${p.name} - ${p.description}\n`;
    }
  }
  
  return `You are a restaurant supply expert analyzing photos to predict what supplies a restaurant needs.

PRODUCT CATALOG:
${productList}

VISUAL CUES TO LOOK FOR:
- Pizza oven → Pizza boxes, pizza savers
- Espresso machine → Hot cups, lids, sleeves
- Deli counter/slicer → Deli paper, sandwich bags
- Takeout counter → Foam containers, plastic bags
- Chinese wok → Takeout boxes, chopsticks
- Taco station → Foil sheets, portion cups
- Bakery display → Cake boxes, pastry bags
- Bar area → Cocktail napkins, straws

INSTRUCTIONS:
1. Describe what you see in the photo (2-3 sentences)
2. Identify the restaurant type/cuisine
3. List the TOP 5-8 products this restaurant would need
4. For each product, explain WHY based on what you see
5. Rate your confidence (low/medium/high)

RESPOND IN THIS EXACT JSON FORMAT:
{
  "description": "What I see in the photo...",
  "cuisine_type": "pizza|chinese|mexican|cafe|deli|bakery|bar|general",
  "confidence": "low|medium|high",
  "products": [
    {
      "sku": "PB16",
      "name": "Pizza Box 16\\"",
      "reason": "I can see a pizza oven in the background"
    }
  ],
  "visual_cues_detected": ["pizza oven", "takeout counter"]
}`;
}

async function analyzeWithVision(imageBase64, mimeType = 'image/jpeg') {
  if (!anthropic) {
    return getDemoResponse();
  }
  
  const prompt = buildVisionPrompt();
  
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: imageBase64
              }
            },
            { type: 'text', text: prompt }
          ]
        }
      ]
    });
    
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    } else {
      throw new Error('Could not parse JSON from response');
    }
    
  } catch (err) {
    console.error('Vision API error:', err.message);
    throw err;
  }
}

// Apply learned corrections to improve predictions
function applyCorrections(result, restaurantName, cuisineType) {
  const nameLower = restaurantName?.toLowerCase() || '';
  
  // Apply name-based corrections
  for (const [pattern, correction] of Object.entries(corrections.byName)) {
    if (nameLower.includes(pattern.toLowerCase())) {
      if (correction.add) {
        result.products.push(...correction.add.map(p => ({ 
          ...p, 
          reason: 'Added from learned corrections' 
        })));
      }
      if (correction.remove) {
        result.products = result.products.filter(p => !correction.remove.includes(p.sku));
      }
    }
  }
  
  // Apply cuisine-based corrections
  if (cuisineType && corrections.byCuisine[cuisineType]) {
    const c = corrections.byCuisine[cuisineType];
    if (c.always_include) {
      for (const sku of c.always_include) {
        if (!result.products.find(p => p.sku === sku)) {
          result.products.push({ sku, name: sku, reason: 'Always included for ' + cuisineType });
        }
      }
    }
    if (c.never_include) {
      result.products = result.products.filter(p => !c.never_include.includes(p.sku));
    }
  }
  
  return result;
}

function getDemoResponse() {
  return {
    description: "Demo mode - no image analysis performed",
    cuisine_type: "general",
    confidence: "low",
    products: [
      { sku: "FOAM9", name: "Foam Container 9x9", reason: "Standard takeout container" },
      { sku: "UTKIT", name: "Utensil Kit", reason: "Basic utensil needs" },
      { sku: "NAP2PLY", name: "Napkin 2-Ply", reason: "Every restaurant needs napkins" }
    ],
    visual_cues_detected: [],
    demo: true
  };
}

function getInlineCatalog() {
  return {
    categories: {
      pizza: {
        name: "Pizza Supplies",
        products: [
          { sku: "PB16", name: "Pizza Box 16\"", description: "Large pizza box" },
          { sku: "PB12", name: "Pizza Box 12\"", description: "Small pizza box" },
          { sku: "PS100", name: "Pizza Saver", description: "Prevents box crush" }
        ]
      },
      takeout: {
        name: "Takeout Containers",
        products: [
          { sku: "FOAM9", name: "Foam Container 9x9", description: "Hinged takeout container" },
          { sku: "FOAM6", name: "Foam Container 6x6", description: "Small takeout container" }
        ]
      },
      general: {
        name: "General Supplies",
        products: [
          { sku: "UTKIT", name: "Utensil Kit", description: "Fork, knife, napkin combo" },
          { sku: "NAP2PLY", name: "Napkin 2-Ply", description: "Dinner napkin" },
          { sku: "STRAW", name: "Straws", description: "Standard drinking straws" }
        ]
      }
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Suplook Vision AI Server',
    anthropicConfigured: !!anthropic,
    googleConfigured: !!config.googleKey,
    yelpConfigured: !!config.yelpKey,
    catalogLoaded: !!productCatalog,
    correctionsCount: Object.keys(corrections.byName).length + 
                      Object.keys(corrections.byCuisine).length
  });
});

// Analyze by image URL
app.post('/analyze/url', async (req, res) => {
  const { imageUrl, restaurantName } = req.body;
  
  if (!imageUrl) {
    return res.status(400).json({ error: 'Missing imageUrl' });
  }
  
  try {
    console.log(`📷 Fetching image from URL...`);
    
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error('Failed to fetch image');
    
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    
    console.log(`🧠 Analyzing with Claude Vision...`);
    
    let result = await analyzeWithVision(base64, contentType);
    result = applyCorrections(result, restaurantName, result.cuisine_type);
    
    res.json({ success: true, analysis: result });
    
  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Analyze by base64 image
app.post('/analyze/image', async (req, res) => {
  const { imageBase64, mimeType, restaurantName } = req.body;
  
  if (!imageBase64) {
    return res.status(400).json({ error: 'Missing imageBase64' });
  }
  
  try {
    let result = await analyzeWithVision(imageBase64, mimeType || 'image/jpeg');
    result = applyCorrections(result, restaurantName, result.cuisine_type);
    
    res.json({ success: true, analysis: result });
    
  } catch (err) {
    console.error('Analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HUMAN-IN-THE-LOOP: Corrections API
// This is the moat - every correction makes the AI smarter
// ═══════════════════════════════════════════════════════════════════════════

app.post('/feedback', (req, res) => {
  const { restaurantName, cuisineType, originalProducts, correctedProducts } = req.body;
  
  try {
    const originalSkus = originalProducts.map(p => p.sku);
    const correctedSkus = correctedProducts.map(p => p.sku);
    
    const added = correctedProducts.filter(p => !originalSkus.includes(p.sku));
    const removed = originalSkus.filter(sku => !correctedSkus.includes(sku));
    
    // Store corrections by cuisine type
    if (cuisineType) {
      if (!corrections.byCuisine[cuisineType]) {
        corrections.byCuisine[cuisineType] = { always_include: [], never_include: [] };
      }
      
      for (const p of added) {
        if (!corrections.byCuisine[cuisineType].always_include.includes(p.sku)) {
          corrections.byCuisine[cuisineType].always_include.push(p.sku);
        }
      }
      
      for (const sku of removed) {
        if (!corrections.byCuisine[cuisineType].never_include.includes(sku)) {
          corrections.byCuisine[cuisineType].never_include.push(sku);
        }
      }
    }
    
    // Store corrections by name patterns
    const nameLower = (restaurantName || '').toLowerCase();
    const patterns = ['pizza', 'taco', 'burger', 'sushi', 'thai', 'indian', 'deli', 'cafe', 'bakery'];
    
    for (const pattern of patterns) {
      if (nameLower.includes(pattern)) {
        if (!corrections.byName[pattern]) {
          corrections.byName[pattern] = { add: [], remove: [] };
        }
        corrections.byName[pattern].add.push(...added);
        corrections.byName[pattern].remove.push(...removed);
      }
    }
    
    saveCorrections();
    
    console.log(`📝 Correction saved: +${added.length} -${removed.length}`);
    
    res.json({
      success: true,
      added: added.length,
      removed: removed.length,
      totalCorrections: Object.keys(corrections.byName).length + 
                        Object.keys(corrections.byCuisine).length
    });
    
  } catch (err) {
    console.error('Feedback error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/corrections', (req, res) => {
  res.json(corrections);
});

// ═══════════════════════════════════════════════════════════════════════════
// OUTCOME TRACKING
// Track what actually sells to improve predictions
// ═══════════════════════════════════════════════════════════════════════════

app.post('/leads/:id/outcome', (req, res) => {
  const { id } = req.params;
  const { outcome, notes, actual_products } = req.body;
  
  const leadIndex = leads.findIndex(l => l.id === id);
  if (leadIndex === -1) {
    return res.status(404).json({ error: 'Lead not found' });
  }
  
  leads[leadIndex].outcome = outcome; // 'no_reply', 'replied', 'sold', 'lost'
  leads[leadIndex].outcome_notes = notes || null;
  leads[leadIndex].outcome_at = new Date().toISOString();
  
  // If salesperson provided actual products needed, save as training data
  if (actual_products && actual_products.length > 0) {
    leads[leadIndex].actual_products_needed = actual_products;
    
    // Store field feedback in corrections
    const cuisineType = leads[leadIndex].detected_cuisine || 'general';
    if (!corrections.byField) corrections.byField = {};
    if (!corrections.byField[cuisineType]) corrections.byField[cuisineType] = [];
    
    corrections.byField[cuisineType].push({
      restaurant: leads[leadIndex].name,
      ai_suggested: leads[leadIndex].products_original || leads[leadIndex].products,
      actual_needed: actual_products,
      outcome: outcome,
      recorded_at: new Date().toISOString()
    });
    
    saveCorrections();
    console.log(`📊 Field feedback saved: ${leads[leadIndex].name} → Actually needed: ${actual_products.join(', ')}`);
  }
  
  saveLeads();
  
  res.json({ success: true, lead: leads[leadIndex] });
});

// Get outcome statistics
app.get('/stats/outcomes', (req, res) => {
  const outcomes = {
    total: leads.length,
    no_outcome: leads.filter(l => !l.outcome).length,
    no_reply: leads.filter(l => l.outcome === 'no_reply').length,
    replied: leads.filter(l => l.outcome === 'replied').length,
    sold: leads.filter(l => l.outcome === 'sold').length,
    lost: leads.filter(l => l.outcome === 'lost').length
  };
  
  const contacted = outcomes.replied + outcomes.sold + outcomes.lost;
  outcomes.reply_rate = contacted > 0 ? (outcomes.replied / contacted * 100).toFixed(1) + '%' : '0%';
  outcomes.conversion_rate = contacted > 0 ? (outcomes.sold / contacted * 100).toFixed(1) + '%' : '0%';
  
  res.json(outcomes);
});

// Get AI accuracy stats
app.get('/stats/accuracy', (req, res) => {
  const withOutcome = leads.filter(l => l.outcome && l.actual_products_needed);
  
  let correctPredictions = 0;
  let totalPredictions = 0;
  
  for (const lead of withOutcome) {
    const predicted = new Set(lead.products_original || lead.products);
    const actual = new Set(lead.actual_products_needed);
    
    for (const product of predicted) {
      totalPredictions++;
      if (actual.has(product)) correctPredictions++;
    }
  }
  
  res.json({
    leads_with_feedback: withOutcome.length,
    total_predictions: totalPredictions,
    correct_predictions: correctPredictions,
    accuracy: totalPredictions > 0 ? (correctPredictions / totalPredictions * 100).toFixed(1) + '%' : 'N/A',
    corrections_count: Object.keys(corrections.byName || {}).length + 
                       Object.keys(corrections.byCuisine || {}).length
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LEADS API
// ═══════════════════════════════════════════════════════════════════════════

app.get('/leads', (req, res) => {
  res.json({ count: leads.length, leads });
});

app.post('/leads', (req, res) => {
  const lead = {
    id: `lead_${Date.now()}`,
    ...req.body,
    created_at: new Date().toISOString()
  };
  
  leads.unshift(lead);
  saveLeads();
  
  res.json({ success: true, lead });
});

app.post('/leads/:id/graduate', (req, res) => {
  const { id } = req.params;
  const { products, corrected } = req.body;
  
  const leadIndex = leads.findIndex(l => l.id === id);
  if (leadIndex === -1) {
    return res.status(404).json({ error: 'Lead not found' });
  }
  
  leads[leadIndex].graduated = true;
  if (products) leads[leadIndex].products = products;
  if (corrected) leads[leadIndex].ai_corrected = true;
  
  saveLeads();
  
  res.json({
    success: true,
    lead: leads[leadIndex],
    pending: leads.filter(l => !l.graduated).length
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`
═══════════════════════════════════════════════════════════════
  SUPLOOK SERVER
  Visual AI for Foodservice Distribution
  Running on http://localhost:${PORT}
═══════════════════════════════════════════════════════════════
  
  Core Endpoints:
  - GET  /health              Health check & status
  - POST /analyze/image       Analyze base64 image
  - POST /analyze/url         Analyze image URL
  - POST /feedback            Submit correction (builds the moat)
  - GET  /corrections         View learned corrections
  - GET  /stats/accuracy      AI prediction accuracy
  
  Config:
  - Anthropic: ${anthropic ? '✅ Connected' : '⚠️ Demo Mode'}
  - Google: ${config.googleKey ? '✅ Connected' : '⚠️ Not configured'}
  - Yelp: ${config.yelpKey ? '✅ Connected' : '⚠️ Not configured'}
  
═══════════════════════════════════════════════════════════════
  `);
});

module.exports = app;
