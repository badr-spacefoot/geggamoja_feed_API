const DASHBOARD_VERSION = '2026-06-05-ean-sort-movements';
const ACTIONS_WORKFLOW_RUNS_URL = 'https://api.github.com/repos/badr-spacefoot/geggamoja_feed_API/actions/workflows/generate-feed.yml/runs?branch=main&per_page=1';
const REQUIRED_FIELDS = ['variant_sku', 'barcode', 'price_amount', 'image_url', 'product_type'];
const EURO = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' });
const INT = new Intl.NumberFormat('en-US');
const state = {
  rows: [],
  filteredRows: [],
  history: [],
  changes: null,
  charts: {},
  sort: { key: 'stock', direction: 'desc' },
  pageSize: 100
};
let feedStatusTimer = null;

const el = (id) => document.getElementById(id);
const text = (id, value) => { el(id).textContent = value; };
const clean = (value) => String(value ?? '').trim();
const isPresent = (value) => clean(value) !== '';
const toNumber = (value) => {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
};
const variantKey = (row) => clean(row.variant_id) || clean(row.variant_sku) || `${clean(row.product_id)}:${clean(row.barcode)}`;
const productKey = (row) => clean(row.product_id) || clean(row.product_handle) || clean(row.product_title);
const typeName = (row) => clean(row.product_type) || 'Unclassified';

window.addEventListener('DOMContentLoaded', () => {
  bindFilters();
  bindSorting();
  el('refreshButton').addEventListener('click', loadDashboard);
  loadDashboard();
  updateFeedGenerationStatus();
});

async function updateFeedGenerationStatus() {
  try {
    const response = await fetch(`${ACTIONS_WORKFLOW_RUNS_URL}&ts=${Date.now()}`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`GitHub Actions returned ${response.status}`);
    const payload = await response.json();
    const run = payload.workflow_runs?.[0];

    if (!run) {
      setFeedStatus('Feed status unavailable', 'No workflow run found yet.', 'pending');
      scheduleFeedStatusRefresh(120000);
      return;
    }

    if (isActiveRun(run)) {
      const activeStep = await getCurrentWorkflowStep(run.jobs_url);
      const detail = activeStep ? `Current step: ${activeStep}` : `Started: ${formatDateTime(run.run_started_at || run.created_at)}`;
      setFeedStatus('Feed generation in progress', detail, 'running');
      scheduleFeedStatusRefresh(30000);
      return;
    }

    if (run.conclusion === 'success') {
      setFeedStatus('Feed ready', `Last workflow success: ${formatDateTime(run.updated_at)}`, 'success');
      scheduleFeedStatusRefresh(120000);
      return;
    }

    setFeedStatus('Last generation needs attention', `${describeConclusion(run.conclusion)}: ${formatDateTime(run.updated_at)}`, 'error');
    scheduleFeedStatusRefresh(120000);
  } catch (error) {
    setFeedStatus('Feed status unavailable', error.message || 'Could not read GitHub Actions status.', 'pending');
    scheduleFeedStatusRefresh(120000);
  }
}

async function getCurrentWorkflowStep(jobsUrl) {
  if (!jobsUrl) return '';
  try {
    const response = await fetch(`${jobsUrl}${jobsUrl.includes('?') ? '&' : '?'}ts=${Date.now()}`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) return '';
    const payload = await response.json();
    const job = payload.jobs?.find((item) => item.status === 'in_progress') || payload.jobs?.[0];
    const step = job?.steps?.find((item) => item.status === 'in_progress') || job?.steps?.find((item) => item.status === 'queued' || item.status === 'pending');
    return step?.name || job?.name || '';
  } catch (_error) {
    return '';
  }
}

function setFeedStatus(label, detail, status) {
  const container = el('feedStatus');
  if (!container) return;
  container.className = `feed-status ${status}`;
  text('feedStatusLabel', label);
  text('feedStatusDetail', detail);
}

function scheduleFeedStatusRefresh(delay) {
  window.clearTimeout(feedStatusTimer);
  feedStatusTimer = window.setTimeout(updateFeedGenerationStatus, delay);
}

function isActiveRun(run) {
  return ['queued', 'pending', 'waiting', 'requested', 'in_progress'].includes(run.status);
}

function describeConclusion(conclusion) {
  return conclusion ? conclusion.replace(/_/g, ' ') : 'Unknown status';
}

async function loadDashboard() {
  showAlert('', false);
  try {
    ensureLibraries();
    const [metadata, csvText, history, changes] = await Promise.all([loadMetadata(), loadCsvText(), loadHistory(), loadChanges()]);
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: 'greedy' });
    if (parsed.errors?.length) {
      throw new Error(`CSV parsing failed: ${parsed.errors[0].message}`);
    }

    state.rows = parsed.data.map(normalizeRow).filter((row) => variantKey(row));
    state.history = history;
    state.changes = changes;
    if (state.rows.length === 0) {
      throw new Error('feed.csv was loaded, but it did not contain any variants.');
    }

    renderDashboard(metadata);
  } catch (error) {
    renderEmptyState();
    showAlert(error.message || 'Could not load feed.csv. Run the GitHub Actions workflow to generate the feed.', true);
  }
}

function ensureLibraries() {
  if (!window.Papa) throw new Error('PapaParse could not be loaded from the CDN.');
  if (!window.Chart) throw new Error('Chart.js could not be loaded from the CDN.');
}

async function loadMetadata() {
  try {
    const response = await fetch(`feed-meta.json?ts=${Date.now()}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return response.json();
  } catch (_error) {
    return null;
  }
}

async function loadHistory() {
  try {
    const response = await fetch(`feed-history.json?ts=${Date.now()}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload?.snapshots) ? payload.snapshots : [];
  } catch (_error) {
    return [];
  }
}

async function loadChanges() {
  try {
    const response = await fetch(`feed-changes.json?ts=${Date.now()}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return response.json();
  } catch (_error) {
    return null;
  }
}

async function loadCsvText() {
  const response = await fetch(`feed.csv?ts=${Date.now()}`, { headers: { Accept: 'text/csv' } });
  if (!response.ok) {
    throw new Error('feed.csv is not available yet. Run the GitHub Actions workflow first.');
  }
  return response.text();
}

function normalizeRow(row) {
  const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, clean(value)]));
  normalized.stock = toNumber(normalized.inventory_available);
  normalized.price = toNumber(normalized.price_amount);
  normalized.status = clean(normalized.product_status).toUpperCase() || 'UNKNOWN';
  normalized.productType = typeName(normalized);
  normalized.normalizedBarcode = normalizeBarcode(normalized.barcode);
  normalized.eanStatus = getEanStatus(normalized.barcode);
  normalized.updatedDate = normalized.updated_at ? new Date(normalized.updated_at) : null;
  if (Number.isNaN(normalized.updatedDate?.valueOf())) normalized.updatedDate = null;
  return normalized;
}

function renderDashboard(metadata) {
  const stats = calculateStats(state.rows);
  text('totalProducts', INT.format(stats.totalProducts));
  text('totalVariants', INT.format(stats.totalVariants));
  text('activeVariants', INT.format(stats.activeVariants));
  text('draftVariants', INT.format(stats.draftVariants));
  text('totalStock', INT.format(stats.totalStock));
  text('variantsWithStock', INT.format(stats.variantsWithStock));
  text('badEans', INT.format(stats.badEans));
  text('qualityScore', `${stats.qualityScore}%`);

  text('missingBarcode', INT.format(stats.missing.barcode));
  text('badEansDetail', INT.format(stats.badEans));
  text('missingImage', INT.format(stats.missing.image_url));
  text('missingPrice', INT.format(stats.missing.price_amount));
  text('missingStock', INT.format(stats.missingStock));
  text('missingProductType', INT.format(stats.missing.product_type));

  const lastGenerated = metadata?.generatedAt ? new Date(metadata.generatedAt) : stats.lastUpdated;
  text('lastUpdated', lastGenerated ? `Last CSV update: ${lastGenerated.toLocaleString()}` : 'Last CSV update: unavailable');

  renderCharts(stats);
  renderHistory(stats, metadata);
  renderChanges();
  renderProductTypes(stats.productTypes);
  renderRecentUpdates(state.rows);
  populateFilters(state.rows);
  applyFilters();
}

function calculateStats(rows) {
  const variants = uniqueRows(rows, variantKey);
  const products = new Set(rows.map(productKey).filter(Boolean));
  const activeVariants = variants.filter((row) => row.status === 'ACTIVE').length;
  const draftVariants = variants.filter((row) => row.status === 'DRAFT').length;
  const totalStock = variants.reduce((sum, row) => sum + row.stock, 0);
  const variantsWithStock = variants.filter((row) => row.stock > 0).length;
  const variantsOutOfStock = variants.length - variantsWithStock;
  const missing = Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, variants.filter((row) => !isPresent(row[field])).length]));
  const badEans = variants.filter((row) => row.eanStatus === 'bad').length;
  const validRequiredFields = variants.reduce((sum, row) => sum + REQUIRED_FIELDS.filter((field) => isPresent(row[field])).length, 0);
  const validEans = variants.filter((row) => row.eanStatus === 'valid').length;
  const totalRequiredFields = variants.length * (REQUIRED_FIELDS.length + 1);
  const qualityScore = totalRequiredFields ? Math.round(((validRequiredFields + validEans) / totalRequiredFields) * 100) : 0;
  const missingStock = variants.filter((row) => !isPresent(row.inventory_available)).length;
  const lastUpdated = variants.map((row) => row.updatedDate).filter(Boolean).sort((a, b) => b - a)[0] ?? null;

  return {
    totalProducts: products.size,
    totalVariants: variants.length,
    activeVariants,
    draftVariants,
    totalStock,
    variantsWithStock,
    variantsOutOfStock,
    missing,
    missingStock,
    badEans,
    qualityScore,
    productTypes: groupProductTypes(variants),
    priceBuckets: buildPriceBuckets(variants),
    lastUpdated
  };
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

function groupProductTypes(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.productType;
    const entry = groups.get(key) ?? { type: key, variants: 0, stock: 0, priceSum: 0, priced: 0 };
    entry.variants += 1;
    entry.stock += row.stock;
    if (row.price > 0) {
      entry.priceSum += row.price;
      entry.priced += 1;
    }
    groups.set(key, entry);
  }
  return [...groups.values()]
    .map((entry) => ({ ...entry, averagePrice: entry.priced ? entry.priceSum / entry.priced : 0 }))
    .sort((a, b) => b.variants - a.variants || b.stock - a.stock);
}

function buildPriceBuckets(rows) {
  const buckets = [
    { label: '0-10', min: 0, max: 10, count: 0 },
    { label: '10-25', min: 10, max: 25, count: 0 },
    { label: '25-50', min: 25, max: 50, count: 0 },
    { label: '50-100', min: 50, max: 100, count: 0 },
    { label: '100+', min: 100, max: Infinity, count: 0 }
  ];
  for (const row of rows.filter((item) => item.price > 0)) {
    buckets.find((bucket) => row.price >= bucket.min && row.price < bucket.max).count += 1;
  }
  return buckets;
}

function renderCharts(stats) {
  destroyCharts(['status', 'stock', 'prices', 'missing']);
  const colors = ['#145a4a', '#e0a72e', '#5b8def', '#d95f59', '#7c3aed', '#0891b2', '#65a30d', '#f97316'];
  state.charts.status = new Chart(el('statusChart'), {
    type: 'doughnut',
    data: { labels: ['Active', 'Draft', 'Other'], datasets: [{ data: [stats.activeVariants, stats.draftVariants, Math.max(0, stats.totalVariants - stats.activeVariants - stats.draftVariants)], backgroundColor: ['#145a4a', '#e0a72e', '#cbd5e1'], borderWidth: 0 }] },
    options: chartOptions()
  });

  const topStockTypes = stats.productTypes.slice(0, 8);
  state.charts.stock = new Chart(el('stockTypeChart'), {
    type: 'bar',
    data: { labels: topStockTypes.map((item) => item.type), datasets: [{ label: 'Available stock', data: topStockTypes.map((item) => item.stock), backgroundColor: colors }] },
    options: chartOptions({ indexAxis: 'y' })
  });

  state.charts.prices = new Chart(el('priceChart'), {
    type: 'bar',
    data: { labels: stats.priceBuckets.map((bucket) => bucket.label), datasets: [{ label: 'Variants', data: stats.priceBuckets.map((bucket) => bucket.count), backgroundColor: '#5b8def' }] },
    options: chartOptions()
  });

  state.charts.missing = new Chart(el('missingChart'), {
    type: 'bar',
    data: { labels: ['Missing barcode', 'Bad EAN', 'Missing image', 'Missing price', 'Missing product type'], datasets: [{ label: 'Variants', data: [stats.missing.barcode, stats.badEans, stats.missing.image_url, stats.missing.price_amount, stats.missing.product_type], backgroundColor: '#d95f59' }] },
    options: chartOptions()
  });
}

function renderHistory(stats, metadata) {
  const currentSnapshot = buildCurrentSnapshot(stats, metadata);
  const snapshots = normalizeHistory([...state.history, currentSnapshot]);
  const latest = snapshots.at(-1);
  const previous = snapshots.length > 1 ? snapshots.at(-2) : null;

  text('deltaProducts', formatDelta(latest?.productCount, previous?.productCount));
  text('deltaVariants', formatDelta(latest?.variantCount, previous?.variantCount));
  text('deltaStock', formatDelta(latest?.totalStock, previous?.totalStock));
  text('deltaQuality', formatDelta(latest?.qualityScore, previous?.qualityScore, '%'));

  renderHistoryChart(snapshots);
  renderHistoryTable(snapshots);
}

function buildCurrentSnapshot(stats, metadata) {
  return {
    generatedAt: metadata?.generatedAt || new Date().toISOString(),
    productCount: stats.totalProducts,
    variantCount: stats.totalVariants,
    activeVariants: stats.activeVariants,
    draftVariants: stats.draftVariants,
    totalStock: stats.totalStock,
    variantsWithStock: stats.variantsWithStock,
    variantsOutOfStock: stats.variantsOutOfStock,
    qualityScore: stats.qualityScore,
    badEans: stats.badEans,
    rowCount: metadata?.rowCount ?? stats.totalVariants
  };
}

function normalizeHistory(snapshots) {
  const byDate = new Map();
  for (const snapshot of snapshots) {
    if (!snapshot?.generatedAt) continue;
    const date = new Date(snapshot.generatedAt);
    if (Number.isNaN(date.valueOf())) continue;
    const dayKey = date.toISOString().slice(0, 10);
    byDate.set(dayKey, {
      generatedAt: date.toISOString(),
      productCount: toNumber(snapshot.productCount),
      variantCount: toNumber(snapshot.variantCount ?? snapshot.rowCount),
      totalStock: toNumber(snapshot.totalStock),
      qualityScore: toNumber(snapshot.qualityScore),
      badEans: toNumber(snapshot.badEans),
      rowCount: toNumber(snapshot.rowCount)
    });
  }
  return [...byDate.values()].sort((a, b) => new Date(a.generatedAt) - new Date(b.generatedAt)).slice(-60);
}

function renderHistoryChart(snapshots) {
  destroyCharts(['history']);
  if (snapshots.length === 0) {
    el('historyBody').innerHTML = '<tr><td colspan="5">No history available yet.</td></tr>';
    return;
  }

  state.charts.history = new Chart(el('historyChart'), {
    type: 'line',
    data: {
      labels: snapshots.map((snapshot) => shortDate(snapshot.generatedAt)),
      datasets: [
        { label: 'Variants', data: snapshots.map((snapshot) => snapshot.variantCount), borderColor: '#5b8def', backgroundColor: '#5b8def', tension: 0.3, yAxisID: 'y' },
        { label: 'Stock', data: snapshots.map((snapshot) => snapshot.totalStock), borderColor: '#145a4a', backgroundColor: '#145a4a', tension: 0.3, yAxisID: 'y' },
        { label: 'Quality %', data: snapshots.map((snapshot) => snapshot.qualityScore), borderColor: '#e0a72e', backgroundColor: '#e0a72e', tension: 0.3, yAxisID: 'quality' }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: { legend: { position: 'bottom' } },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } },
        quality: { beginAtZero: true, max: 100, position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: (value) => `${value}%` } }
      }
    }
  });
}

function renderHistoryTable(snapshots) {
  const rows = snapshots.slice(-10).reverse().map((snapshot) => `
    <tr>
      <td>${shortDate(snapshot.generatedAt)}</td>
      <td>${INT.format(snapshot.productCount)}</td>
      <td>${INT.format(snapshot.variantCount)}</td>
      <td>${INT.format(snapshot.totalStock)}</td>
      <td>${INT.format(snapshot.qualityScore)}%</td>
    </tr>
  `).join('');
  el('historyBody').innerHTML = rows || '<tr><td colspan="5">No history available yet.</td></tr>';
}

function renderChanges() {
  const changes = state.changes;
  const newProducts = Array.isArray(changes?.newProducts) ? changes.newProducts : [];
  const stockDrops = Array.isArray(changes?.stockDrops) ? changes.stockDrops : [];

  el('newProductsBody').innerHTML = newProducts.slice(0, 12).map((item) => `
    <tr><td>${escapeHtml(item.title || item.handle || '-')}</td><td>${escapeHtml(item.productType || '-')}</td><td>${INT.format(item.variantCount || 0)}</td><td>${INT.format(item.stock || 0)}</td></tr>
  `).join('') || '<tr><td colspan="4">No newly added products detected yet.</td></tr>';

  el('stockMoversBody').innerHTML = stockDrops.slice(0, 12).map((item) => `
    <tr><td>${escapeHtml(item.title || item.handle || '-')}</td><td>${INT.format(item.previousStock || 0)}</td><td>${INT.format(item.currentStock || 0)}</td><td><span class="badge stock-out">${INT.format(item.delta || 0)}</span></td></tr>
  `).join('') || '<tr><td colspan="4">No stock decreases detected yet.</td></tr>';
}

function chartOptions(extra = {}) {
  return { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: extra.indexAxis ? undefined : { y: { beginAtZero: true, ticks: { precision: 0 } } }, ...extra };
}

function destroyCharts(keys = Object.keys(state.charts)) {
  keys.forEach((key) => {
    state.charts[key]?.destroy();
    delete state.charts[key];
  });
}

function renderProductTypes(productTypes) {
  const rows = productTypes.slice(0, 12).map((item) => `
    <tr><td>${escapeHtml(item.type)}</td><td>${INT.format(item.variants)}</td><td>${INT.format(item.stock)}</td><td>${item.averagePrice ? EURO.format(item.averagePrice) : '-'}</td></tr>
  `).join('');
  el('productTypesBody').innerHTML = rows || '<tr><td colspan="4">No product types found.</td></tr>';
}

function renderRecentUpdates(rows) {
  const recent = uniqueRows(rows, variantKey).filter((row) => row.updatedDate).sort((a, b) => b.updatedDate - a.updatedDate).slice(0, 10);
  el('recentUpdatesBody').innerHTML = recent.map((row) => `
    <tr><td>${row.updatedDate.toLocaleString()}</td><td>${escapeHtml(row.variant_sku || '-')}</td><td>${escapeHtml(row.product_title || '-')}</td><td>${INT.format(row.stock)}</td></tr>
  `).join('') || '<tr><td colspan="4">No update dates found.</td></tr>';
}

function populateFilters(rows) {
  const statuses = [...new Set(rows.map((row) => row.status).filter(Boolean))].sort();
  const types = [...new Set(rows.map((row) => row.productType).filter(Boolean))].sort();
  setOptions(el('statusFilter'), statuses, 'All statuses');
  setOptions(el('typeFilter'), types, 'All product types');
}

function setOptions(select, options, firstLabel) {
  const current = select.value;
  select.innerHTML = `<option value="">${firstLabel}</option>${options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('')}`;
  select.value = options.includes(current) ? current : '';
}

function bindFilters() {
  ['searchInput', 'statusFilter', 'stockFilter', 'typeFilter', 'eanFilter'].forEach((id) => el(id).addEventListener('input', applyFilters));
  el('pageSizeSelect').addEventListener('input', () => {
    const value = el('pageSizeSelect').value;
    state.pageSize = value === 'all' ? Infinity : toNumber(value);
    renderVariantTable();
  });
}

function bindSorting() {
  document.querySelectorAll('[data-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.sort;
      const sameKey = state.sort.key === key;
      state.sort = { key, direction: sameKey && state.sort.direction === 'asc' ? 'desc' : 'asc' };
      applyFilters();
    });
  });
}

function applyFilters() {
  const search = clean(el('searchInput').value).toLowerCase();
  const status = el('statusFilter').value;
  const stock = el('stockFilter').value;
  const type = el('typeFilter').value;
  const ean = el('eanFilter').value;
  const variants = uniqueRows(state.rows, variantKey);
  state.filteredRows = sortRows(variants.filter((row) => {
    const matchesSearch = !search || [row.variant_sku, row.product_title, row.barcode, row.productType].some((value) => clean(value).toLowerCase().includes(search));
    const matchesStatus = !status || row.status === status;
    const matchesStock = !stock || (stock === 'in' ? row.stock > 0 : row.stock <= 0);
    const matchesType = !type || row.productType === type;
    const matchesEan = !ean || row.eanStatus === ean;
    return matchesSearch && matchesStatus && matchesStock && matchesType && matchesEan;
  }));
  renderVariantTable();
  updateSortButtons();
}

function sortRows(rows) {
  const { key, direction } = state.sort;
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => compareSortValue(sortValue(a, key), sortValue(b, key)) * multiplier);
}

function sortValue(row, key) {
  if (key === 'price' || key === 'stock') return row[key];
  if (key === 'productType') return row.productType;
  return clean(row[key]).toLowerCase();
}

function compareSortValue(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return (a || 0) - (b || 0);
  return String(a).localeCompare(String(b));
}

function updateSortButtons() {
  document.querySelectorAll('[data-sort]').forEach((button) => {
    const active = button.dataset.sort === state.sort.key;
    button.classList.toggle('active', active);
    button.textContent = `${button.textContent.replace(/ [↑↓]$/, '')}${active ? (state.sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}`;
  });
}

function renderVariantTable() {
  const limit = Number.isFinite(state.pageSize) ? state.pageSize : state.filteredRows.length;
  const visible = state.filteredRows.slice(0, limit);
  el('filterSummary').textContent = `Showing ${INT.format(visible.length)} of ${INT.format(state.filteredRows.length)} matching variants${state.filteredRows.length > visible.length ? ` (first ${INT.format(limit)} shown)` : ''}.`;
  el('variantsBody').innerHTML = visible.map((row) => `
    <tr>
      <td>${renderThumbnail(row)}</td>
      <td>${escapeHtml(row.variant_sku || '-')}</td>
      <td>${renderBarcode(row)}</td>
      <td class="product-cell"><strong>${escapeHtml(row.product_title || '-')}</strong><span>${escapeHtml(row.product_handle || '')}</span></td>
      <td>${escapeHtml(row.productType)}</td>
      <td><span class="badge ${row.status.toLowerCase()}">${escapeHtml(row.status)}</span></td>
      <td>${row.price ? EURO.format(row.price) : '-'}</td>
      <td><span class="badge ${row.stock > 0 ? 'stock-in' : 'stock-out'}">${INT.format(row.stock)}</span></td>
    </tr>
  `).join('') || '<tr><td colspan="8">No variants match the selected filters.</td></tr>';
}

function renderBarcode(row) {
  if (row.eanStatus === 'missing') return '<span class="muted">-</span>';
  const badgeClass = row.eanStatus === 'valid' ? 'ean-valid' : 'ean-bad';
  const label = row.eanStatus === 'valid' ? 'Valid EAN' : 'Bad EAN';
  return `<span>${escapeHtml(row.barcode)}</span><span class="ean-pill ${badgeClass}">${label}</span>`;
}

function renderThumbnail(row) {
  const src = clean(row.image_url);
  if (!src) return '<div class="product-thumb empty" aria-label="No image">No image</div>';
  const title = escapeHtml(row.product_title || row.variant_sku || 'Product image');
  return `<a class="product-thumb" href="${escapeAttribute(src)}" target="_blank" rel="noopener"><img src="${escapeAttribute(src)}" alt="${title}" loading="lazy" onerror="this.closest('a').classList.add('empty'); this.remove();" /></a>`;
}

function getEanStatus(value) {
  const barcode = normalizeBarcode(value);
  if (!barcode) return 'missing';
  return isValidEan(barcode) ? 'valid' : 'bad';
}

function normalizeBarcode(value) {
  return clean(value).replace(/[\s-]/g, '');
}

function isValidEan(value) {
  if (!/^\d{8}$|^\d{13}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const checkDigit = digits.pop();
  const sum = digits.reduce((total, digit, index) => {
    const weight = value.length === 13 ? (index % 2 === 0 ? 1 : 3) : (index % 2 === 0 ? 3 : 1);
    return total + digit * weight;
  }, 0);
  return (10 - (sum % 10)) % 10 === checkDigit;
}

function renderEmptyState() {
  ['totalProducts', 'totalVariants', 'activeVariants', 'draftVariants', 'totalStock', 'variantsWithStock', 'badEans', 'qualityScore', 'missingBarcode', 'badEansDetail', 'missingImage', 'missingPrice', 'missingStock', 'missingProductType', 'deltaProducts', 'deltaVariants', 'deltaStock', 'deltaQuality'].forEach((id) => text(id, '-'));
  text('lastUpdated', 'Last CSV update: unavailable');
  el('productTypesBody').innerHTML = '<tr><td colspan="4">No data available.</td></tr>';
  el('recentUpdatesBody').innerHTML = '<tr><td colspan="4">No data available.</td></tr>';
  el('newProductsBody').innerHTML = '<tr><td colspan="4">No data available.</td></tr>';
  el('stockMoversBody').innerHTML = '<tr><td colspan="4">No data available.</td></tr>';
  el('variantsBody').innerHTML = '<tr><td colspan="8">No data available.</td></tr>';
  el('historyBody').innerHTML = '<tr><td colspan="5">No history available.</td></tr>';
  destroyCharts();
}

function formatDelta(current, previous, suffix = '') {
  if (current == null || previous == null) return '-';
  const delta = current - previous;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${INT.format(delta)}${suffix}`;
}

function shortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '-';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return 'unknown time';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function showAlert(message, visible) {
  const alert = el('alert');
  alert.textContent = message;
  alert.hidden = !visible;
}

function escapeHtml(value) {
  return clean(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}
