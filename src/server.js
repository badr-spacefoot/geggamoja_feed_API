import dotenv from 'dotenv';
import express from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter, requireAuthEnv, requireLogin } from './auth.js';
import { generateFeedCsv } from './feed.js';
import { validateShopifyEnv } from './shopify.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');
const port = Number(process.env.PORT ?? 3000);
let latestFeed = null;

function validateEnvironment() {
  requireAuthEnv(process.env);
  validateShopifyEnv(process.env);
}

validateEnvironment();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

app.use(
  session({
    name: 'geggamoja.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

app.use(authRouter({ appPassword: process.env.APP_PASSWORD, publicDir }));

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get(['/', '/index.html'], requireLogin, (_req, res) => {
  res.sendFile('index.html', { root: publicDir });
});

app.get('/api/feed.csv', requireLogin, async (_req, res, next) => {
  try {
    const csv = await generateFeedCsv(process.env);
    latestFeed = { csv, generatedAt: new Date() };
    sendCsvDownload(res, csv, latestFeed.generatedAt);
  } catch (error) {
    next(error);
  }
});

app.get('/api/feed/latest.csv', requireLogin, (_req, res) => {
  if (!latestFeed) {
    res.status(404).type('text/plain').send('No CSV has been generated since this server started. Use Generate CSV first.');
    return;
  }
  sendCsvDownload(res, latestFeed.csv, latestFeed.generatedAt);
});

function sendCsvDownload(res, csv, generatedAt) {
  const timestamp = generatedAt.toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="geggamoja-b2b-catalog-${timestamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(csv);
}

app.use(express.static(publicDir, { index: false, extensions: false }));

app.use((req, res) => {
  res.status(404).send(`Not found: ${req.path}`);
});

app.use((error, req, res, _next) => {
  console.error(error);
  const message = process.env.NODE_ENV === 'production' ? 'Could not generate the feed. Check server logs.' : error.message;
  if (req.path.endsWith('.csv')) {
    res.status(500).type('text/plain').send(message);
    return;
  }
  res.status(500).send(message);
});

app.listen(port, () => {
  console.log(`Geggamoja feed app listening on http://localhost:${port}`);
});
