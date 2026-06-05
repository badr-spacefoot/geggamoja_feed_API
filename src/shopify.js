const REQUIRED_SHOPIFY_ENV = [
  'SHOPIFY_SHOP_DOMAIN',
  'SHOPIFY_ADMIN_API_VERSION',
  'SHOPIFY_ADMIN_ACCESS_TOKEN',
  'SHOPIFY_PUBLICATION_GID',
  'SHOPIFY_PRICE_LIST_GID'
];

const DEFAULT_MAX_RETRIES = 4;
const MIN_RETRY_DELAY_MS = 1000;
const NON_RETRYABLE_ERROR = Symbol('nonRetryableError');

export function validateShopifyEnv(env = process.env) {
  const missing = REQUIRED_SHOPIFY_ENV.filter((key) => !env[key]);
  if (!env.SHOPIFY_CATALOG_GID && !env.SHOPIFY_CATALOG_ID) missing.push('SHOPIFY_CATALOG_GID or SHOPIFY_CATALOG_ID');
  if (missing.length > 0) {
    throw new Error(`Missing required Shopify environment variable(s): ${missing.join(', ')}`);
  }

  const shopDomain = env.SHOPIFY_SHOP_DOMAIN.trim();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shopDomain) && !/^[a-z0-9.-]+$/i.test(shopDomain)) {
    throw new Error('SHOPIFY_SHOP_DOMAIN must be a valid Shopify shop domain, for example example.myshopify.com.');
  }

  if (env.SHOPIFY_CATALOG_ID && !/^\d+$/.test(env.SHOPIFY_CATALOG_ID.trim())) {
    throw new Error('SHOPIFY_CATALOG_ID must contain only digits when provided.');
  }

  for (const key of ['SHOPIFY_PUBLICATION_GID', 'SHOPIFY_PRICE_LIST_GID']) {
    if (!env[key].startsWith('gid://shopify/')) {
      throw new Error(`${key} must be a Shopify GraphQL gid, for example gid://shopify/Publication/123.`);
    }
  }

  if (env.SHOPIFY_CATALOG_GID && !env.SHOPIFY_CATALOG_GID.startsWith('gid://shopify/Catalog/')) {
    throw new Error('SHOPIFY_CATALOG_GID must be a Shopify Catalog gid, for example gid://shopify/Catalog/123.');
  }
}

export function getCatalogGid(env = process.env) {
  return env.SHOPIFY_CATALOG_GID || `gid://shopify/Catalog/${env.SHOPIFY_CATALOG_ID}`;
}

export function createShopifyClient(env = process.env) {
  validateShopifyEnv(env);

  const endpoint = `https://${env.SHOPIFY_SHOP_DOMAIN.trim()}/admin/api/${env.SHOPIFY_ADMIN_API_VERSION.trim()}/graphql.json`;
  const accessToken = env.SHOPIFY_ADMIN_ACCESS_TOKEN;

  async function graphql(query, variables = {}, options = {}) {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    let attempt = 0;
    let lastError;

    while (attempt <= maxRetries) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': accessToken
          },
          body: JSON.stringify({ query, variables })
        });

        const bodyText = await response.text();
        let payload;
        try {
          payload = bodyText ? JSON.parse(bodyText) : {};
        } catch (parseError) {
          throw new Error(`Shopify returned non-JSON response with status ${response.status}: ${bodyText.slice(0, 200)}`);
        }

        if (response.status === 429 || response.status >= 500) {
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after')) ?? backoffMs(attempt);
          if (attempt < maxRetries) {
            await sleep(retryAfterMs);
            attempt += 1;
            continue;
          }
        }

        if (!response.ok) {
          const error = new Error(`Shopify HTTP error ${response.status}: ${summarizePayload(payload)}`);
          if (response.status < 500 && response.status !== 429) error[NON_RETRYABLE_ERROR] = true;
          throw error;
        }

        if (payload.errors?.length) {
          const throttled = payload.errors.some((error) => error.extensions?.code === 'THROTTLED');
          if (throttled && attempt < maxRetries) {
            await sleep(backoffMs(attempt));
            attempt += 1;
            continue;
          }
          const error = new Error(`Shopify GraphQL error(s): ${payload.errors.map((error) => error.message).join('; ')}`);
          error[NON_RETRYABLE_ERROR] = true;
          throw error;
        }

        await pauseForThrottle(payload.extensions?.cost?.throttleStatus);
        return payload.data;
      } catch (error) {
        lastError = error;
        if (error?.[NON_RETRYABLE_ERROR] || attempt >= maxRetries) break;
        await sleep(backoffMs(attempt));
        attempt += 1;
      }
    }

    throw lastError ?? new Error('Shopify request failed.');
  }

  return { graphql, endpoint };
}

function summarizePayload(payload) {
  if (payload?.errors?.length) return payload.errors.map((error) => error.message).join('; ');
  return JSON.stringify(payload).slice(0, 500);
}

function parseRetryAfter(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(MIN_RETRY_DELAY_MS, seconds * 1000);
  return undefined;
}

function backoffMs(attempt) {
  return MIN_RETRY_DELAY_MS * 2 ** attempt;
}

async function pauseForThrottle(throttleStatus) {
  if (!throttleStatus) return;
  const { currentlyAvailable, restoreRate } = throttleStatus;
  if (typeof currentlyAvailable !== 'number' || typeof restoreRate !== 'number' || restoreRate <= 0) return;
  if (currentlyAvailable > 100) return;
  const pointsToRestore = 200 - currentlyAvailable;
  await sleep(Math.ceil((pointsToRestore / restoreRate) * 1000));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
