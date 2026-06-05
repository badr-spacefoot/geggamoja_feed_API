const REQUIRED_FIELDS = ['variant_sku', 'barcode', 'price_amount', 'image_url', 'product_type'];
const EURO = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' });
const INT = new Intl.NumberFormat('en-US');
const state = { rows: [], filteredRows: [], charts: {} };

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
  el('refreshButton').addEventListener('click', loadDashboard);
  loadDashboard();
});

async function loadDashboard() {
  showAlert('', false);
  try {
    ensureLibraries();
    const [metadata, csvText] = await Promise.all([loadMetadata(), loadCsvText()]);
    const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: 'greedy' });
    if (parsed.errors?.length) {
      throw new Error(`CSV parsing failed: ${parsed.errors[0].message}`);
    }

    state.rows = parsed.data.map(normalizeRow).filter((row) => variantKey(row));
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
  text('variantsOutOfStock', INT.format(stats.variantsOutOfStock));
  text('qualityScore', `${stats.qualityScore}%`);

  text('missingBarcode', INT.format(stats.missing.barcode));
  text('missingImage', INT.format(stats.missing.image_url));
  text('missingPrice', INT.format(stats.missing.price_amount));
  text('missingStock', INT.format(stats.missingStock));
  text('missingProductType', INT.format(stats.missing.product_type));

  const lastGenerated = metadata?.generatedAt ? new Date(metadata.generatedAt) : stats.lastUpdated;
  text('lastUpdated', lastGenerated ? `Last CSV update: ${lastGenerated.toLocaleString()}` : 'Last CSV update: unavailable');

  renderCharts(stats);
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
  const validRequiredFields = variants.reduce((sum, row) => sum + REQUIRED_FIELDS.filter((field) => isPresent(row[field])).length, 0);
  const totalRequiredFields = variants.length * REQUIRED_FIELDS.length;
  const qualityScore = totalRequiredFields ? Math.round((validRequiredFields / totalRequiredFields) * 100) : 0;
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
    { label: '0–10', min: 0, max: 10, count: 0 },
    { label: '10–25', min: 10, max: 25, count: 0 },
    { label: '25–50', min: 25, max: 50, count: 0 },
    { label: '50–100', min: 50, max: 100, count: 0 },
    { label: '100+', min: 100, max: Infinity, count: 0 }
  ];
  for (const row of rows.filter((item) => item.price > 0)) {
    buckets.find((bucket) => row.price >= bucket.min && row.price < bucket.max).count += 1;
  }
  return buckets;
}

function renderCharts(stats) {
  destroyCharts();
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
    data: { labels: ['Barcode', 'Image', 'Price', 'Product type'], datasets: [{ label: 'Missing', data: [stats.missing.barcode, stats.missing.image_url, stats.missing.price_amount, stats.missing.product_type], backgroundColor: '#d95f59' }] },
    options: chartOptions()
  });
}

function chartOptions(extra = {}) {
  return { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: extra.indexAxis ? undefined : { y: { beginAtZero: true, ticks: { precision: 0 } } }, ...extra };
}

function destroyCharts() {
  Object.values(state.charts).forEach((chart) => chart?.destroy());
  state.charts = {};
}

function renderProductTypes(productTypes) {
  const rows = productTypes.slice(0, 12).map((item) => `
    <tr><td>${escapeHtml(item.type)}</td><td>${INT.format(item.variants)}</td><td>${INT.format(item.stock)}</td><td>${item.averagePrice ? EURO.format(item.averagePrice) : '—'}</td></tr>
  `).join('');
  el('productTypesBody').innerHTML = rows || '<tr><td colspan="4">No product types found.</td></tr>';
}

function renderRecentUpdates(rows) {
  const recent = uniqueRows(rows, variantKey).filter((row) => row.updatedDate).sort((a, b) => b.updatedDate - a.updatedDate).slice(0, 10);
  el('recentUpdatesBody').innerHTML = recent.map((row) => `
    <tr><td>${row.updatedDate.toLocaleString()}</td><td>${escapeHtml(row.variant_sku || '—')}</td><td>${escapeHtml(row.product_title || '—')}</td><td>${INT.format(row.stock)}</td></tr>
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
  ['searchInput', 'statusFilter', 'stockFilter', 'typeFilter'].forEach((id) => el(id).addEventListener('input', applyFilters));
}

function applyFilters() {
  const search = clean(el('searchInput').value).toLowerCase();
  const status = el('statusFilter').value;
  const stock = el('stockFilter').value;
  const type = el('typeFilter').value;
  const variants = uniqueRows(state.rows, variantKey);
  state.filteredRows = variants.filter((row) => {
    const matchesSearch = !search || [row.variant_sku, row.product_title, row.barcode].some((value) => clean(value).toLowerCase().includes(search));
    const matchesStatus = !status || row.status === status;
    const matchesStock = !stock || (stock === 'in' ? row.stock > 0 : row.stock <= 0);
    const matchesType = !type || row.productType === type;
    return matchesSearch && matchesStatus && matchesStock && matchesType;
  });
  renderVariantTable();
}

function renderVariantTable() {
  const visible = state.filteredRows.slice(0, 100);
  el('filterSummary').textContent = `Showing ${INT.format(visible.length)} of ${INT.format(state.filteredRows.length)} matching variants${state.filteredRows.length > visible.length ? ' (first 100 shown)' : ''}.`;
  el('variantsBody').innerHTML = visible.map((row) => `
    <tr>
      <td>${escapeHtml(row.variant_sku || '—')}</td>
      <td>${escapeHtml(row.barcode || '—')}</td>
      <td>${escapeHtml(row.product_title || '—')}</td>
      <td>${escapeHtml(row.productType)}</td>
      <td><span class="badge ${row.status.toLowerCase()}">${escapeHtml(row.status)}</span></td>
      <td>${row.price ? EURO.format(row.price) : '—'}</td>
      <td><span class="badge ${row.stock > 0 ? 'stock-in' : 'stock-out'}">${INT.format(row.stock)}</span></td>
    </tr>
  `).join('') || '<tr><td colspan="7">No variants match the selected filters.</td></tr>';
}

function renderEmptyState() {
  ['totalProducts', 'totalVariants', 'activeVariants', 'draftVariants', 'totalStock', 'variantsWithStock', 'variantsOutOfStock', 'qualityScore', 'missingBarcode', 'missingImage', 'missingPrice', 'missingStock', 'missingProductType'].forEach((id) => text(id, '—'));
  text('lastUpdated', 'Last CSV update: unavailable');
  ['productTypesBody', 'recentUpdatesBody', 'variantsBody'].forEach((id) => { el(id).innerHTML = '<tr><td colspan="7">No data available.</td></tr>'; });
  destroyCharts();
}

function showAlert(message, visible) {
  const alert = el('alert');
  alert.textContent = message;
  alert.hidden = !visible;
}

function escapeHtml(value) {
  return clean(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
