import dotenv from 'dotenv';
import express from 'express';
import session from 'express-session';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter, requireAuthEnv, requireLogin } from './auth.js';
import { generateFeed, generateFeedCsv } from './feed.js';
import { validateShopifyEnv } from './shopify.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');
const port = Number(process.env.PORT ?? 3000);
let latestFeed = null;
const jobs = new Map();
const JOB_RETENTION_MS = 1000 * 60 * 60;

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


app.post('/api/generate', requireLogin, (_req, res) => {
  const job = createGenerationJob();
  jobs.set(job.jobId, job);
  res.status(202).json(toJobStatus(job));

  setImmediate(() => runGenerationJob(job));
});

app.get('/api/generate/status/:jobId', requireLogin, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({
      status: 'failed',
      step: 'Done',
      current: 0,
      total: 0,
      message: 'Generation job was not found. It may have expired.',
      error: 'Job not found.'
    });
    return;
  }

  res.status(200).json(toJobStatus(job));
});

function createGenerationJob() {
  const now = new Date();
  return {
    jobId: crypto.randomUUID(),
    status: 'queued',
    step: 'Fetching products',
    current: 0,
    total: 0,
    message: 'Queued CSV generation.',
    error: undefined,
    downloadUrl: undefined,
    rowCount: undefined,
    startedAt: undefined,
    completedAt: undefined,
    createdAt: now
  };
}

async function runGenerationJob(job) {
  job.status = 'running';
  job.startedAt = new Date();
  job.message = 'Starting Shopify catalog feed generation.';

  try {
    const { csv, rowCount } = await generateFeed(process.env, {
      onProgress: (progress) => updateJobProgress(job, progress)
    });
    const generatedAt = new Date();
    latestFeed = { csv, generatedAt, rowCount };
    job.status = 'completed';
    job.step = 'Done';
    job.current = rowCount;
    job.total = rowCount;
    job.rowCount = rowCount;
    job.completedAt = generatedAt;
    job.downloadUrl = '/api/feed/latest.csv';
    job.message = `Generated ${rowCount} CSV rows in ${formatElapsed(job.startedAt, job.completedAt)}.`;
  } catch (error) {
    job.status = 'failed';
    job.step = job.step || 'Done';
    job.error = error.message;
    job.message = 'CSV generation failed.';
    job.completedAt = new Date();
    console.error(error);
  } finally {
    setTimeout(() => jobs.delete(job.jobId), JOB_RETENTION_MS).unref?.();
  }
}

function updateJobProgress(job, progress) {
  job.status = 'running';
  job.step = progress.step ?? job.step;
  job.current = Number(progress.current ?? job.current ?? 0);
  job.total = Number(progress.total ?? job.total ?? 0);
  job.message = progress.message ?? job.message;
}

function toJobStatus(job) {
  const elapsedMs = (job.completedAt ?? new Date()).valueOf() - (job.startedAt ?? job.createdAt).valueOf();
  return {
    jobId: job.jobId,
    status: job.status,
    step: job.step,
    current: job.current,
    total: job.total,
    message: job.message,
    ...(job.error ? { error: job.error } : {}),
    ...(job.downloadUrl ? { downloadUrl: job.downloadUrl } : {}),
    ...(job.rowCount !== undefined ? { rowCount: job.rowCount } : {}),
    elapsedSeconds: Math.max(0, Math.round(elapsedMs / 1000))
  };
}

function formatElapsed(startedAt, completedAt) {
  const seconds = Math.max(0, Math.round((completedAt.valueOf() - startedAt.valueOf()) / 1000));
  return `${seconds}s`;
}

app.get('/api/feed.csv', requireLogin, async (_req, res, next) => {
  try {
    const csv = await generateFeedCsv(process.env);
    latestFeed = { csv, generatedAt: new Date() };
    sendCsvDownload(res, csv, latestFeed.generatedAt);
  } catch (error) {
    next(error);
  }
});

app.get(['/api/feed/latest.csv', '/api/latest-feed.csv'], requireLogin, (_req, res) => {
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
