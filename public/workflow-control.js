const WORKFLOW_CONTROL_VERSION = '2026-06-06-run-feed-from-dashboard';
const WORKFLOW_DISPATCH_URL = 'https://api.github.com/repos/badr-spacefoot/geggamoja_feed_API/actions/workflows/generate-feed.yml/dispatches';
const WORKFLOW_TOKEN_STORAGE_KEY = 'geggamoja-actions-token';
let workflowDispatching = false;
let workflowSyncTimer = null;

window.addEventListener('DOMContentLoaded', () => {
  const button = el('runWorkflowButton');
  if (!button) return;
  button.addEventListener('click', requestFeedGeneration);
  syncRunWorkflowButton();
});

async function requestFeedGeneration() {
  if (workflowDispatching) return;
  workflowDispatching = true;
  setRunWorkflowButton('Checking workload...', true);
  showAlert('', false);
  try {
    const run = await getLatestWorkflowRun();
    if (run && isActiveRun(run)) {
      setFeedStatus('Feed generation already in progress', `Started: ${formatDateTime(run.run_started_at || run.created_at)}`, 'running');
      setRunWorkflowButton('Workload running', true);
      scheduleWorkflowButtonRefresh(30000);
      scheduleFeedStatusRefresh(30000);
      return;
    }

    const token = getWorkflowToken();
    if (!token) {
      setRunWorkflowButton('Run workload', false);
      return;
    }

    const response = await fetch(WORKFLOW_DISPATCH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ref: 'main' })
    });

    if (response.status === 204) {
      setFeedStatus('Feed generation requested', 'GitHub Actions is starting the workload...', 'running');
      setRunWorkflowButton('Workload starting', true);
      scheduleFeedStatusRefresh(10000);
      scheduleWorkflowButtonRefresh(12000);
      return;
    }

    if (response.status === 401 || response.status === 403) {
      localStorage.removeItem(WORKFLOW_TOKEN_STORAGE_KEY);
      throw new Error('GitHub token rejected. Create a fine-grained token with Actions: write access, then try again.');
    }

    throw new Error(`GitHub Actions dispatch failed with status ${response.status}.`);
  } catch (error) {
    showAlert(error.message || 'Could not start the feed generation workflow.', true);
    setRunWorkflowButton('Run workload', false);
  } finally {
    workflowDispatching = false;
  }
}

async function syncRunWorkflowButton() {
  const button = el('runWorkflowButton');
  if (!button || workflowDispatching) return;
  try {
    const run = await getLatestWorkflowRun();
    if (run && isActiveRun(run)) {
      setRunWorkflowButton('Workload running', true);
      scheduleWorkflowButtonRefresh(30000);
      return;
    }
    setRunWorkflowButton('Run workload', false);
  } catch (_error) {
    setRunWorkflowButton('Run workload', false);
  }
}

async function getLatestWorkflowRun() {
  const response = await fetch(`${ACTIONS_WORKFLOW_RUNS_URL}&ts=${Date.now()}`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`GitHub Actions returned ${response.status}`);
  return (await response.json()).workflow_runs?.[0] || null;
}

function getWorkflowToken() {
  const saved = localStorage.getItem(WORKFLOW_TOKEN_STORAGE_KEY);
  if (saved) return saved;
  const token = window.prompt('Paste a GitHub fine-grained token with Actions: write access for badr-spacefoot/geggamoja_feed_API. It will be stored only in this browser localStorage.');
  const cleaned = clean(token);
  if (!cleaned) return '';
  localStorage.setItem(WORKFLOW_TOKEN_STORAGE_KEY, cleaned);
  return cleaned;
}

function setRunWorkflowButton(label, disabled) {
  const button = el('runWorkflowButton');
  if (!button) return;
  button.textContent = label;
  button.disabled = disabled;
  button.classList.toggle('disabled', disabled);
}

function scheduleWorkflowButtonRefresh(delay) {
  window.clearTimeout(workflowSyncTimer);
  workflowSyncTimer = window.setTimeout(syncRunWorkflowButton, delay);
}
