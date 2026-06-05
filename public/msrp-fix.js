const MSRP_FIX_VERSION = '2026-06-06-msrp-zero-is-missing';
const WORKFLOW_PAGE_URL = 'https://github.com/badr-spacefoot/geggamoja_feed_API/actions/workflows/generate-feed.yml';
let workflowButtonTimer = null;

function hasValidMsrp(row) {
  return isPresent(row.price_amount) && row.price > 0;
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
  missing.price_amount = variants.filter((row) => !hasValidMsrp(row)).length;
  const badEans = variants.filter((row) => row.eanStatus === 'bad').length;
  const requiredFieldScore = variants.reduce((sum, row) => {
    return sum + REQUIRED_FIELDS.filter((field) => field === 'price_amount' ? hasValidMsrp(row) : isPresent(row[field])).length;
  }, 0);
  const validEans = variants.filter((row) => row.eanStatus === 'valid').length;
  const totalRequiredFields = variants.length * (REQUIRED_FIELDS.length + 1);
  const qualityScore = totalRequiredFields ? Math.round(((requiredFieldScore + validEans) / totalRequiredFields) * 100) : 0;
  const missingStock = variants.filter((row) => !isPresent(row.inventory_available)).length;
  const lastUpdated = variants.map((row) => row.updatedDate).filter(Boolean).sort((a, b) => b - a)[0] ?? null;
  return { totalProducts: products.size, totalVariants: variants.length, activeVariants, draftVariants, totalStock, variantsWithStock, variantsOutOfStock, missing, missingStock, badEans, qualityScore, productTypes: groupProductTypes(variants), priceBuckets: buildPriceBuckets(variants), lastUpdated };
}

function renderCharts(stats) {
  destroyCharts(['status', 'stock', 'prices', 'missing']);
  const colors = ['#145a4a', '#e0a72e', '#5b8def', '#d95f59', '#7c3aed', '#0891b2', '#65a30d', '#f97316'];
  state.charts.status = new Chart(el('statusChart'), { type: 'doughnut', data: { labels: ['Active', 'Draft', 'Other'], datasets: [{ data: [stats.activeVariants, stats.draftVariants, Math.max(0, stats.totalVariants - stats.activeVariants - stats.draftVariants)], backgroundColor: ['#145a4a', '#e0a72e', '#cbd5e1'], borderWidth: 0 }] }, options: chartOptions() });
  const topStockTypes = stats.productTypes.slice(0, 8);
  state.charts.stock = new Chart(el('stockTypeChart'), { type: 'bar', data: { labels: topStockTypes.map((item) => item.type), datasets: [{ label: 'Available stock', data: topStockTypes.map((item) => item.stock), backgroundColor: colors }] }, options: chartOptions({ indexAxis: 'y' }) });
  state.charts.prices = new Chart(el('priceChart'), { type: 'bar', data: { labels: stats.priceBuckets.map((bucket) => bucket.label), datasets: [{ label: 'Variants', data: stats.priceBuckets.map((bucket) => bucket.count), backgroundColor: '#5b8def' }] }, options: chartOptions() });
  state.charts.missing = new Chart(el('missingChart'), { type: 'bar', data: { labels: ['Missing barcode', 'Bad EAN', 'Missing image', 'Missing MSRP', 'Missing stock value', 'Missing product type'], datasets: [{ label: 'Variants', data: [stats.missing.barcode, stats.badEans, stats.missing.image_url, stats.missing.price_amount, stats.missingStock, stats.missing.product_type], backgroundColor: '#d95f59' }] }, options: chartOptions() });
}

function renderVariantRow(row) {
  return `<tr><td>${renderThumbnail(row)}</td><td>${escapeHtml(row.variant_sku || '-')}</td><td>${renderBarcode(row)}</td><td class="product-cell"><strong>${renderProductLink(row.product_title || '-', row.product_url)}</strong><span>${escapeHtml(row.product_handle || '')}</span></td><td>${escapeHtml(row.productType)}</td><td><span class="badge ${row.status.toLowerCase()}">${escapeHtml(row.status)}</span></td><td>${hasValidMsrp(row) ? EURO.format(row.price) : '-'}</td><td><span class="badge ${row.stock > 0 ? 'stock-in' : 'stock-out'}">${INT.format(row.stock)}</span></td></tr>`;
}

function renderProductGroup(group) {
  const expanded = state.expandedProducts.has(group.key);
  const validPrices = group.variants.filter(hasValidMsrp).map((row) => row.price);
  const priceMin = validPrices.length ? Math.min(...validPrices) : Infinity;
  const priceMax = validPrices.length ? Math.max(...validPrices) : 0;
  const priceText = priceMin === Infinity ? '-' : priceMin === priceMax ? EURO.format(priceMin) : `${EURO.format(priceMin)} - ${EURO.format(priceMax)}`;
  const childRows = expanded ? group.variants.map((row) => `<tr class="variant-detail-row"><td></td><td>${escapeHtml(row.variant_sku || '-')}</td><td>${renderBarcode(row)}</td><td>${escapeHtml([row.option1_value, row.option2_value, row.option3_value].filter(Boolean).join(' / ') || row.product_title || '-')}</td><td>${escapeHtml(row.productType)}</td><td><span class="badge ${row.status.toLowerCase()}">${escapeHtml(row.status)}</span></td><td>${hasValidMsrp(row) ? EURO.format(row.price) : '-'}</td><td><span class="badge ${row.stock > 0 ? 'stock-in' : 'stock-out'}">${INT.format(row.stock)}</span></td></tr>`).join('') : '';
  return `<tr class="product-group-row"><td>${renderThumbnail(group.first)}</td><td><button class="expand-button" type="button" data-expand-product="${escapeAttribute(group.key)}">${expanded ? 'Hide' : 'Show'} ${INT.format(group.variants.length)}</button></td><td>${group.badEans ? `<span class="ean-pill ean-bad">${INT.format(group.badEans)} bad EAN</span>` : '<span class="ean-pill ean-valid">EAN OK</span>'}</td><td class="product-cell"><strong>${renderProductLink(group.first.product_title || '-', group.first.product_url)}</strong><span>${escapeHtml(group.first.product_handle || '')}</span></td><td>${escapeHtml(group.first.productType)}</td><td><span class="badge ${group.first.status.toLowerCase()}">${escapeHtml(group.first.status)}</span></td><td>${priceText}</td><td><span class="badge ${group.stock > 0 ? 'stock-in' : 'stock-out'}">${INT.format(group.stock)}</span></td></tr>${childRows}`;
}

window.addEventListener('DOMContentLoaded', () => {
  addSafeWorkflowButton();
  refreshSafeWorkflowButton();
});

function addSafeWorkflowButton() {
  const actions = document.querySelector('.hero-actions');
  if (!actions || el('runWorkflowButton')) return;
  const button = document.createElement('button');
  button.id = 'runWorkflowButton';
  button.className = 'button secondary';
  button.type = 'button';
  button.textContent = 'Run workload';
  button.addEventListener('click', openWorkflowIfReady);
  actions.appendChild(button);
}

async function openWorkflowIfReady() {
  setRunWorkflowButton('Checking...', true);
  try {
    const run = await getLatestWorkflowRunSafe();
    if (run && isActiveRun(run)) {
      setFeedStatus('Feed generation already in progress', `Started: ${formatDateTime(run.run_started_at || run.created_at)}`, 'running');
      setRunWorkflowButton('Workload running', true);
      scheduleSafeWorkflowButtonRefresh(30000);
      return;
    }
    window.open(WORKFLOW_PAGE_URL, '_blank', 'noopener');
    setRunWorkflowButton('Open GitHub Actions', false);
  } catch (error) {
    showAlert(error.message || 'Could not check GitHub Actions status.', true);
    setRunWorkflowButton('Open GitHub Actions', false);
  }
}

async function refreshSafeWorkflowButton() {
  const button = el('runWorkflowButton');
  if (!button) return;
  try {
    const run = await getLatestWorkflowRunSafe();
    if (run && isActiveRun(run)) {
      setRunWorkflowButton('Workload running', true);
      scheduleSafeWorkflowButtonRefresh(30000);
      return;
    }
    setRunWorkflowButton('Run workload', false);
  } catch (_error) {
    setRunWorkflowButton('Open GitHub Actions', false);
  }
}

async function getLatestWorkflowRunSafe() {
  const response = await fetch(`${ACTIONS_WORKFLOW_RUNS_URL}&ts=${Date.now()}`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`GitHub Actions returned ${response.status}`);
  return (await response.json()).workflow_runs?.[0] || null;
}

function setRunWorkflowButton(label, disabled) {
  const button = el('runWorkflowButton');
  if (!button) return;
  button.textContent = label;
  button.disabled = disabled;
  button.classList.toggle('disabled', disabled);
}

function scheduleSafeWorkflowButtonRefresh(delay) {
  window.clearTimeout(workflowButtonTimer);
  workflowButtonTimer = window.setTimeout(refreshSafeWorkflowButton, delay);
}
