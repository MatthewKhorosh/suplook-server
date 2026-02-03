# Suplook Server

Visual AI API that analyzes restaurant photos to predict supply needs.

## What It Does

1. **Photo Collection** — Hunts restaurant photos from Yelp, Google Places, and other sources
2. **Vision Analysis** — Uses Claude Vision to analyze photos and predict what supplies a restaurant needs
3. **Human-in-the-Loop Training** — Accepts corrections that improve future predictions
4. **Outcome Tracking** — Tracks what actually sells to measure and improve AI accuracy

## The Moat

Every correction is stored in `corrections.json`. Over time, this builds a proprietary dataset:

```
AI predicts: pizza shop needs X, Y, Z
Human corrects: actually needs X, Y, W
→ Next pizza shop prediction includes W, excludes Z
```

The more you use it, the smarter it gets.

## Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Add your API keys to .env

# Run
npm start
```

## Environment Variables

```
ANTHROPIC_API_KEY=your_key_here    # Required for vision analysis
GOOGLE_API_KEY=your_key_here       # Optional, for Google Places photos
YELP_API_KEY=your_key_here         # Optional, for Yelp photos
AUTH_KEY=your_auth_key             # API authentication
ADMIN_KEY=your_admin_key           # Admin authentication
PORT=3009                          # Server port
```

## API Endpoints

### Analysis

**POST /analyze/url** — Analyze an image by URL
```json
{
  "imageUrl": "https://example.com/restaurant.jpg",
  "restaurantName": "Joe's Pizza"
}
```

**POST /analyze/image** — Analyze a base64 image
```json
{
  "imageBase64": "base64_data_here",
  "mimeType": "image/jpeg",
  "restaurantName": "Joe's Pizza"
}
```

### Corrections (The Moat)

**POST /feedback** — Submit a correction
```json
{
  "restaurantName": "Joe's Pizza",
  "cuisineType": "pizza",
  "originalProducts": [{"sku": "PB16", "name": "Pizza Box 16\""}],
  "correctedProducts": [{"sku": "PB16", "name": "Pizza Box 16\""}, {"sku": "PS100", "name": "Pizza Saver"}]
}
```

**GET /corrections** — View all learned corrections

### Outcome Tracking

**POST /leads/:id/outcome** — Record what actually happened
```json
{
  "outcome": "sold",
  "actual_products": ["PB16", "PS100", "NAP2PLY"]
}
```

**GET /stats/accuracy** — See how accurate predictions are

### Health

**GET /health** — Server status and configuration

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Photo Hunter   │────▶│  Claude Vision  │────▶│  Corrections DB │
│  (Yelp, Google) │     │  (Analysis)     │     │  (THE MOAT)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
                                              ┌─────────────────┐
                                              │ Better Predictions │
                                              └─────────────────┘
```

## Tech Stack

- **Runtime:** Node.js + Express
- **AI:** Claude Vision API (Anthropic)
- **Data Sources:** Yelp Fusion API, Google Places API
- **Storage:** JSON files (swap for database in production)

## License

MIT
