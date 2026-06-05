import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateFeed } from '../src/feed.js';

dotenv.config();

const REQUIRED_FIELDS = ['variant_sku', 'barcode', 'price_amount', 'image_url', 'product_type'];
const outputDir = path.resolve('public');
const feedPath = path.join(outputDir, 'feed.csv');
const metadataPath = path.join(outputDir, 'feed-meta.json');
const historyPath = path.join(outputDir, 'feed-history.json');

try {
  const generatedAt = new Date();
  const { csv, rowCount, productCount } = await generateFeed(process.env, {
    onProgress: ({ step, current, total, message }) => {
      const count = total ? `${current}/${total}` : `${current}`;
      console.log(`[${step}] ${count} ${message ?? ''}`.trim());
    }
  });

  const stats = calculateStats(parseCsvRecords(csv));
  const history = await buildHistory({
    generatedAt: generatedAt.toISOString(),
    productCount: stats.productCount || productCount,
    variantCount: stats.variantCount || rowCount,
    activeVariants: stats.activeVariants,
    draftVariants: stats.draftVariants,
    totalStock: stats.totalStock,
    variantsWithStock: stats.variantsWithStock,
    variantsOutOfStock: stats.variantsOutOfStock,
    qualityScore: stats.qualityScore,
    missing: stats.missing,
    rowCount
  });

  await mkdir(outputDir, { recursive: true });
  await writeFile(feedPath, csv, 'utf8');
  await writeFile(
    metadataPath,
    `${JSON.stringify(
      {
        generatedAt: generatedAt.toISOString(),
        productCount,
        rowCount,
        file: 'feed.csv',
        historyFile: 'feed-history.json'
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');

  console.log(`Wrote ${feedPath}`);
  console.log(`Wrote ${metadataPath}`);
  console.log(`Wrote ${historyPath}`);
  console.log(`Generated ${rowCount} CSV rows for ${productCount} products.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

function calculateStats(rows) {
  const variants = uniqueRows(rows, variantKey);
  const products = new Set(rows.map(productKey).filter(Boolean));
  const activeVariants = variants.filter((row) => clean(row.product_status).toUpperCase() === 'ACTIVE').length;
  const draftVariants = variants.filter((row) => clean(row.product_status).toUpperCase() === 'DRAFT').length;
  const totalStock = variants.reduce((sum, row) => sum + toNumber(row.inventory_available), 0);
  const variantsWithStock = variants.filter((row) => toNumber(row.inventory_available) > 0).length;
  const variantsOutOfStock = variants.length - variantsWithStock;
  const missing = Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, variants.filter((row) => !isPresent(row[field])).length]));
  const validRequiredFields = variants.reduce((sum, row) => sum + REQUIRED_FIELDS.filter((field) => isPresent(row[field])).length, 0);
  const totalRequiredFields = variants.length * REQUIRED_FIELDS.length;
  const qualityScore = totalRequiredFields ? Math.round((validRequiredFields / totalRequiredFields) * 100) : 0;

  return {
    productCount: products.size,
    variantCount: variants.length,
    activeVariants,
    draftVariants,
    totalStock,
    variantsWithStock,
    variantsOutOfStock,
    missing,
    qualityScore
  };
}

async function buildHistory(snapshot) {
  const previous = await loadPublishedHistory();
  const snapshots = Array.isArray(previous?.snapshots) ? previous.snapshots : [];
  const byDay = new Map();

  for (const item of [...snapshots, snapshot]) {
    if (!item?.generatedAt) continue;
    const date = new Date(item.generatedAt);
    if (Number.isNaN(date.valueOf())) continue;
    byDay.set(date.toISOString().slice(0, 10), { ...item, generatedAt: date.toISOString() });
  }

  return {
    updatedAt: snapshot.generatedAt,
    snapshots: [...byDay.values()]
      .sort((a, b) => new Date(a.generatedAt) - new Date(b.generatedAt))
      .slice(-180)
  };
}

async function loadPublishedHistory() {
  const url = getPublishedHistoryUrl();
  if (!url || typeof fetch !== 'function') return null;

  try {
    const response = await fetch(`${url}?ts=${Date.now()}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return response.json();
  } catch (error) {
    console.log(`No published history loaded: ${error.message}`);
    return null;
  }
}

function getPublishedHistoryUrl() {
  if (process.env.FEED_HISTORY_URL) return process.env.FEED_HISTORY_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !repository.includes('/')) return null;
  const [owner, repo] = repository.split('/');
  return `https://${owner}.github.io/${repo}/feed-history.json`;
}

function parseCsvRecords(csv) {
  const rows = [];
  let field = '';
  let row = [];
  let quoted = false;
  const input = String(csv ?? '').replace(/^\uFEFF/, '');

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }

  const headers = rows.shift()?.map((header) => clean(header)) ?? [];
  return rows
    .filter((values) => values.some((value) => clean(value)))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function uniqueRows(rows, keyFn) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = keyFn(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function variantKey(row) {
  return clean(row.variant_id) || clean(row.variant_sku) || `${clean(row.product_id)}:${clean(row.barcode)}`;
}

function productKey(row) {
  return clean(row.product_id) || clean(row.product_handle) || clean(row.product_title);
}

function clean(value) {
  return String(value ?? '').trim();
}

function isPresent(value) {
  return clean(value) !== '';
}

function toNumber(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}
