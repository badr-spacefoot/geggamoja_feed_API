import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getCatalogGid, validateShopifyEnv } from '../src/shopify.js';

const VALID_ENV = {
  SHOPIFY_SHOP_DOMAIN: 'geggamojab2b.myshopify.com',
  SHOPIFY_ADMIN_API_VERSION: '2025-10',
  SHOPIFY_ADMIN_ACCESS_TOKEN: 'replace-with-token',
  SHOPIFY_CATALOG_ID: '88934580363',
  SHOPIFY_CATALOG_GID: 'gid://shopify/Catalog/88934580363',
  SHOPIFY_PUBLICATION_GID: 'gid://shopify/Publication/186172997771',
  SHOPIFY_PRICE_LIST_GID: 'gid://shopify/PriceList/26895024267'
};

test('validates the documented Spacefoot Shopify environment shape', () => {
  assert.doesNotThrow(() => validateShopifyEnv(VALID_ENV));
});

test('derives catalog gid from SHOPIFY_CATALOG_ID when gid is omitted', () => {
  const { SHOPIFY_CATALOG_GID: _gid, ...envWithoutCatalogGid } = VALID_ENV;
  assert.equal(getCatalogGid(envWithoutCatalogGid), 'gid://shopify/Catalog/88934580363');
  assert.doesNotThrow(() => validateShopifyEnv(envWithoutCatalogGid));
});

test('rejects stale non-Catalog catalog gids', () => {
  assert.throws(
    () => validateShopifyEnv({ ...VALID_ENV, SHOPIFY_CATALOG_GID: ['gid://shopify', 'CompanyLocation', 'Catalog/88934580363'].join('/') }),
    /SHOPIFY_CATALOG_GID must be a Shopify Catalog gid/
  );
});

test('requires the app to identify the catalog by gid or numeric id', () => {
  const { SHOPIFY_CATALOG_GID: _gid, SHOPIFY_CATALOG_ID: _id, ...envWithoutCatalog } = VALID_ENV;
  assert.throws(() => validateShopifyEnv(envWithoutCatalog), /SHOPIFY_CATALOG_GID or SHOPIFY_CATALOG_ID/);
});

test('feed GraphQL queries keep Shopify connection page sizes conservative', async () => {
  const feedSource = await readFile(new URL('../src/feed.js', import.meta.url), 'utf8');

  assert.match(feedSource, /const PRODUCTS_PAGE_SIZE = 25;/);
  assert.match(feedSource, /const VARIANTS_PAGE_SIZE = 25;/);
  assert.match(feedSource, /const INVENTORY_LEVELS_PAGE_SIZE = 25;/);
  assert.match(feedSource, /images\(first: 1\)/);
  assert.doesNotMatch(feedSource, /variants\(first: 100/);

  const productsQuery = feedSource.match(new RegExp('const PRODUCTS_QUERY = `[\\s\\S]*?`;'))?.[0] ?? '';
  const variantsQuery = feedSource.match(new RegExp('const PRODUCT_VARIANTS_QUERY = `[\\s\\S]*?`;'))?.[0] ?? '';

  assert.doesNotMatch(productsQuery, /variants\(first:/);
  assert.doesNotMatch(productsQuery, /inventoryLevels\(first:/);
  assert.doesNotMatch(variantsQuery, /inventoryLevels\(first:/);
});
