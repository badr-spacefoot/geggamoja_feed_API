import { stringify } from 'csv-stringify/sync';
import { createShopifyClient, getCatalogGid } from './shopify.js';

const PRODUCTS_PAGE_SIZE = 25;
const VARIANTS_PAGE_SIZE = 25;
const INVENTORY_LEVELS_PAGE_SIZE = 25;
const PRICE_LIST_PRICES_PAGE_SIZE = 50;

export const CSV_COLUMNS = [
  'brand',
  'product_id',
  'product_handle',
  'product_title',
  'product_type',
  'product_status',
  'variant_id',
  'variant_sku',
  'barcode',
  'option1_name',
  'option1_value',
  'option2_name',
  'option2_value',
  'option3_name',
  'option3_value',
  'price_amount',
  'price_currency',
  'compare_at_price',
  'inventory_item_id',
  'inventory_tracked',
  'inventory_available',
  'inventory_on_hand',
  'inventory_committed',
  'inventory_location_id',
  'inventory_location_name',
  'image_url',
  'product_url',
  'tags',
  'updated_at'
];

const PRODUCTS_QUERY = `#graphql
  query CatalogPublicationProducts($publicationId: ID!, $after: String) {
    publication(id: $publicationId) {
      id
      includedProducts(first: ${PRODUCTS_PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          cursor
          node {
            id
            handle
            title
            productType
            status
            tags
            updatedAt
            onlineStoreUrl
            images(first: 1) { nodes { url } }
            options(first: 3) { name values }
          }
        }
      }
    }
  }
`;

const PRODUCT_VARIANTS_QUERY = `#graphql
  query ProductVariants($productId: ID!, $after: String) {
    product(id: $productId) {
      id
      variants(first: ${VARIANTS_PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          sku
          barcode
          title
          selectedOptions { name value }
          price
          compareAtPrice
          image { url }
          updatedAt
          inventoryItem { id tracked }
        }
      }
    }
  }
`;

const INVENTORY_LEVELS_QUERY = `#graphql
  query InventoryLevels($inventoryItemId: ID!, $after: String) {
    inventoryItem(id: $inventoryItemId) {
      id
      inventoryLevels(first: ${INVENTORY_LEVELS_PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          location { id name }
          quantities(names: ["available", "on_hand", "committed"]) { name quantity }
        }
      }
    }
  }
`;

const PRICE_LIST_PRICES_QUERY = `#graphql
  query PriceListPrices($priceListId: ID!, $after: String) {
    priceList(id: $priceListId) {
      id
      currency
      prices(first: ${PRICE_LIST_PRICES_PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          variant { id }
          price { amount currencyCode }
          compareAtPrice { amount currencyCode }
        }
      }
    }
  }
`;

const CATALOG_CHECK_QUERY = `#graphql
  query CatalogCheck($catalogId: ID!) {
    catalog(id: $catalogId) {
      id
      title
      status
      publication { id }
      priceList { id }
    }
  }
`;

export async function generateFeedCsv(env = process.env, options = {}) {
  const { csv } = await generateFeed(env, options);
  return csv;
}

export async function generateFeed(env = process.env, options = {}) {
  const rows = await buildFeedRows(env, undefined, options);
  if (rows.length === 0) {
    throw new Error('The configured Shopify catalog publication returned no products.');
  }

  reportProgress(options.onProgress, {
    step: 'Building CSV',
    current: 0,
    total: rows.length,
    message: `Writing ${rows.length} CSV rows.`
  });

  const csv = stringify(rows, {
    header: true,
    columns: CSV_COLUMNS,
    bom: true,
    quoted_string: true
  });

  reportProgress(options.onProgress, {
    step: 'Done',
    current: rows.length,
    total: rows.length,
    message: `Generated ${rows.length} CSV rows.`
  });

  return { csv, rowCount: rows.length };
}

export async function buildFeedRows(env = process.env, client = createShopifyClient(env), options = {}) {
  const onProgress = options.onProgress;

  await validateCatalogConfiguration(env, client);
  const products = await fetchPublicationProducts(env.SHOPIFY_PUBLICATION_GID, client, onProgress);

  if (products.length === 0) {
    throw new Error('The configured Shopify catalog publication returned no products.');
  }

  const priceList = await fetchPriceListPrices(env.SHOPIFY_PRICE_LIST_GID, client, onProgress);

  if (priceList.currency !== 'EUR') {
    throw new Error(`Expected the configured Shopify price list to use EUR, but received ${priceList.currency}.`);
  }

  reportProgress(onProgress, {
    step: 'Fetching variants',
    current: 0,
    total: products.length,
    message: `Fetching variants for ${products.length} products.`
  });

  let variantCount = 0;
  for (const [index, product] of products.entries()) {
    product.variants = await fetchProductVariants(product.id, client);
    variantCount += product.variants.length;
    reportProgress(onProgress, {
      step: 'Fetching variants',
      current: index + 1,
      total: products.length,
      message: `Fetched ${product.variants.length} variants for ${product.title}.`
    });
  }

  const variants = products.flatMap((product) => product.variants);
  reportProgress(onProgress, {
    step: 'Fetching inventory',
    current: 0,
    total: variants.length,
    message: `Fetching inventory for ${variantCount} variants.`
  });

  for (const [index, variant] of variants.entries()) {
    if (!variant.inventoryItem?.id) {
      variant.inventoryItem = variant.inventoryItem ?? { id: '', tracked: '' };
      variant.inventoryItem.inventoryLevels = { nodes: [] };
    } else {
      variant.inventoryItem.inventoryLevels = { nodes: await fetchInventoryLevels(variant.inventoryItem.id, client) };
    }
    reportProgress(onProgress, {
      step: 'Fetching inventory',
      current: index + 1,
      total: variants.length,
      message: `Fetched inventory for ${variant.sku || variant.title || variant.id}.`
    });
  }

  const prices = priceList.prices;
  const rows = [];
  for (const product of products) {
    for (const variant of product.variants) {
      const inventoryLevel = summarizeInventoryLevels(variant.inventoryItem?.inventoryLevels?.nodes ?? []);
      rows.push(
        toCsvRow({ product, variant, inventoryLevel, priceEntry: prices.get(variant.id), priceListCurrency: priceList.currency, env })
      );
    }
  }

  return rows;
}

async function validateCatalogConfiguration(env, client) {
  const catalogGid = getCatalogGid(env);
  const data = await client.graphql(CATALOG_CHECK_QUERY, { catalogId: catalogGid });
  const catalog = data.catalog;
  if (!catalog) {
    throw new Error(`Shopify catalog was not found: ${catalogGid}`);
  }

  if (catalog.publication?.id && catalog.publication.id !== env.SHOPIFY_PUBLICATION_GID) {
    throw new Error('SHOPIFY_PUBLICATION_GID does not match the configured catalog publication.');
  }

  if (catalog.priceList?.id && catalog.priceList.id !== env.SHOPIFY_PRICE_LIST_GID) {
    throw new Error('SHOPIFY_PRICE_LIST_GID does not match the configured catalog price list.');
  }
}

async function fetchPublicationProducts(publicationId, client, onProgress) {
  const products = [];
  let after;

  do {
    const data = await client.graphql(PRODUCTS_QUERY, { publicationId, after });
    const connection = data.publication?.includedProducts;
    if (!connection) {
      throw new Error(`Shopify publication was not found or has no included products connection: ${publicationId}`);
    }

    products.push(...(connection.edges ?? []).map((edge) => ({ ...edge.node, variants: [] })));

    reportProgress(onProgress, {
      step: 'Fetching products',
      current: products.length,
      total: 0,
      message: `Fetched ${products.length} products from the catalog publication.`
    });

    assertPageInfo(connection.pageInfo, 'Shopify product pagination failed');
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : undefined;
  } while (after);

  return products;
}

async function fetchProductVariants(productId, client) {
  const variants = [];
  let after;

  do {
    const data = await client.graphql(PRODUCT_VARIANTS_QUERY, { productId, after });
    const connection = data.product?.variants;
    if (!connection) {
      throw new Error(`Shopify variant pagination failed for product ${productId}.`);
    }

    variants.push(...(connection.nodes ?? []));
    assertPageInfo(connection.pageInfo, `Shopify variant pagination failed for product ${productId}`);
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : undefined;
  } while (after);

  return variants;
}

async function fetchInventoryLevels(inventoryItemId, client) {
  const inventoryLevels = [];
  let after;

  do {
    const data = await client.graphql(INVENTORY_LEVELS_QUERY, { inventoryItemId, after });
    const connection = data.inventoryItem?.inventoryLevels;
    if (!connection) {
      throw new Error(`Shopify inventory pagination failed for inventory item ${inventoryItemId}.`);
    }

    inventoryLevels.push(...(connection.nodes ?? []));
    assertPageInfo(connection.pageInfo, `Shopify inventory pagination failed for inventory item ${inventoryItemId}`);
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : undefined;
  } while (after);

  return inventoryLevels;
}

async function fetchPriceListPrices(priceListId, client, onProgress) {
  const prices = new Map();
  let after;
  let currency;

  do {
    const data = await client.graphql(PRICE_LIST_PRICES_QUERY, { priceListId, after });
    const priceList = data.priceList;
    if (!priceList) {
      throw new Error(`Shopify price list was not found: ${priceListId}`);
    }
    currency = priceList.currency;

    const connection = priceList.prices;
    for (const node of connection?.nodes ?? []) {
      if (!node.variant?.id) continue;
      prices.set(node.variant.id, {
        amount: node.price?.amount,
        currency: node.price?.currencyCode ?? currency,
        compareAtPrice: node.compareAtPrice?.amount
      });
    }

    reportProgress(onProgress, {
      step: 'Fetching prices',
      current: prices.size,
      total: 0,
      message: `Fetched ${prices.size} price-list entries.`
    });

    assertPageInfo(connection?.pageInfo, 'Shopify price list pagination failed');
    after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : undefined;
  } while (after);

  return { prices, currency };
}

function reportProgress(onProgress, progress) {
  if (typeof onProgress === 'function') {
    onProgress(progress);
  }
}

function assertPageInfo(pageInfo, message) {
  if (pageInfo?.hasNextPage && !pageInfo.endCursor) {
    throw new Error(`${message}: missing endCursor.`);
  }
}

function toCsvRow({ product, variant, inventoryLevel, priceEntry, priceListCurrency, env }) {
  const options = normalizeOptions(product, variant);
  return {
    brand: 'Geggamoja',
    product_id: product.id,
    product_handle: product.handle,
    product_title: product.title,
    product_type: product.productType,
    product_status: product.status,
    variant_id: variant.id,
    variant_sku: variant.sku,
    barcode: variant.barcode,
    option1_name: options[0]?.name ?? '',
    option1_value: options[0]?.value ?? '',
    option2_name: options[1]?.name ?? '',
    option2_value: options[1]?.value ?? '',
    option3_name: options[2]?.name ?? '',
    option3_value: options[2]?.value ?? '',
    price_amount: priceEntry?.amount ?? variant.price ?? '',
    price_currency: priceEntry?.currency ?? priceListCurrency ?? 'EUR',
    compare_at_price: priceEntry?.compareAtPrice ?? variant.compareAtPrice ?? '',
    inventory_item_id: variant.inventoryItem?.id ?? '',
    inventory_tracked: variant.inventoryItem?.tracked ?? '',
    inventory_available: inventoryLevel.quantities.available,
    inventory_on_hand: inventoryLevel.quantities.on_hand,
    inventory_committed: inventoryLevel.quantities.committed,
    inventory_location_id: inventoryLevel.location?.id ?? '',
    inventory_location_name: inventoryLevel.location?.name ?? '',
    image_url: variant.image?.url ?? product.images?.nodes?.[0]?.url ?? '',
    product_url: product.onlineStoreUrl ?? `https://${env.SHOPIFY_SHOP_DOMAIN}/products/${product.handle}`,
    tags: (product.tags ?? []).join(', '),
    updated_at: latestTimestamp(product.updatedAt, variant.updatedAt)
  };
}

function normalizeOptions(product, variant) {
  const selectedOptions = variant.selectedOptions ?? [];
  if (selectedOptions.length > 0) return selectedOptions.slice(0, 3);
  return (product.options ?? []).slice(0, 3).map((option) => ({ name: option.name, value: option.values?.[0] ?? '' }));
}

function summarizeInventoryLevels(inventoryLevels) {
  if (inventoryLevels.length === 0) return emptyInventoryLevel();

  const summary = {
    location: {
      id: inventoryLevels.map((level) => level.location?.id).filter(Boolean).join(', '),
      name: inventoryLevels.map((level) => level.location?.name).filter(Boolean).join(', ')
    },
    quantities: { available: 0, on_hand: 0, committed: 0 }
  };

  for (const level of inventoryLevels) {
    const quantities = quantitiesToObject(level.quantities ?? []);
    for (const name of ['available', 'on_hand', 'committed']) {
      summary.quantities[name] += Number(quantities[name] || 0);
    }
  }

  return summary;
}

function quantitiesToObject(quantities) {
  return quantities.reduce(
    (accumulator, item) => ({ ...accumulator, [item.name]: item.quantity }),
    { available: '', on_hand: '', committed: '' }
  );
}

function emptyInventoryLevel() {
  return {
    location: null,
    quantities: { available: '', on_hand: '', committed: '' }
  };
}

function latestTimestamp(...timestamps) {
  const dates = timestamps.filter(Boolean).map((value) => new Date(value)).filter((date) => !Number.isNaN(date.valueOf()));
  if (dates.length === 0) return '';
  return new Date(Math.max(...dates.map((date) => date.valueOf()))).toISOString();
}
