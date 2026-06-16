require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const trackRoutes = require('./routes/track');
const apiRoutes = require('./routes/api');

const app = express();

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // required for tracking pixel
  contentSecurityPolicy: false // tracking pixel loaded cross-origin
}));

// CORS — in dev allow all localhost origins; in production lock to extension origin
const allowedOrigins = [
  /^chrome-extension:\/\//,         // Chrome extension
  /^http:\/\/localhost(:\d+)?$/,    // Local dev
];
app.use(cors({
  origin: (origin, callback) => {
    const allowed = !origin ||
      origin === 'https://mail.google.com' ||
      origin.startsWith('chrome-extension://') ||
      /^http:\/\/localhost(:\d+)?$/.test(origin);
    callback(allowed ? null : new Error('Not allowed by CORS'), allowed);
  },
  methods: ['GET', 'POST'],
  credentials: false
}));

app.use(express.json({ limit: '50kb' }));

// Rate limiting for tracking endpoints — 60 requests per minute per IP
const trackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' }
});

// Rate limiting for API endpoints — 100 requests per minute
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/t', trackLimiter, trackRoutes);
app.use('/api', apiLimiter, apiRoutes);

// Opt-out page (rendered HTML for recipients)
app.get('/optout', (req, res) => {
  const { id } = req.query;
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Opt out of email tracking</title>
    <style>body{font-family:sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#333}
    h1{font-size:20px}button{background:#333;color:#fff;border:none;padding:10px 20px;
    border-radius:6px;cursor:pointer;font-size:14px}</style></head>
    <body>
    <h1>Opt out of email read receipts</h1>
    <p>Clicking below will prevent future read receipts from being logged for your email address.</p>
    <button onclick="optOut('${encodeURIComponent(id || '')}')">Opt out</button>
    <p id="msg"></p>
    <script>
    async function optOut(id) {
      const res = await fetch('/api/optout', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ trackingId: decodeURIComponent(id) })
      });
      document.getElementById('msg').textContent =
        res.ok ? 'Done. You will no longer be tracked.' : 'Something went wrong.';
    }
    </script>
    </body></html>
  `);
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Tracker server running on http://localhost:${PORT}`));
