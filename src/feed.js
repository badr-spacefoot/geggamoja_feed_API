import { stringify } from 'csv-stringify/sync';
import { createShopifyClient } from './shopify.js';

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
      products(first: 50, after: $after) {
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
            featuredMedia { preview { image { url } } }
            options(first: 3) { name values }
            variants(first: 100) {
              pageInfo { hasNextPage endCursor }
              nodes { ...VariantFields }
            }
          }
        }
      }
    }
  }

  fragment VariantFields on ProductVariant {
    id
    sku
    barcode
    title
    selectedOptions { name value }
    price
    compareAtPrice
    image { url }
    updatedAt
    inventoryItem {
      id
      tracked
      inventoryLevels(first: 50) {
        pageInfo { hasNextPage endCursor }
        nodes {
          location { id name }
          quantities(names: ["available", "on_hand", "committed"]) { name quantity }
        }
      }
    }
  }
`;

const PRODUCT_VARIANTS_QUERY = `#graphql
  query ProductVariants($productId: ID!, $after: String) {
    product(id: $productId) {
      id
      variants(first: 100, after: $after) {
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
          inventoryItem {
            id
            tracked
            inventoryLevels(first: 50) {
              pageInfo { hasNextPage endCursor }
              nodes {
                location { id name }
                quantities(names: ["available", "on_hand", "committed"]) { name quantity }
              }
            }
          }
        }
      }
    }
  }
`;

const INVENTORY_LEVELS_QUERY = `#graphql
  query InventoryLevels($inventoryItemId: ID!, $after: String) {
    inventoryItem(id: $inventoryItemId) {
      id
      inventoryLevels(first: 50, after: $after) {
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
      prices(first: 250, after: $after) {
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

export async function generateFeedCsv(env = process.env) {
  const rows = await buildFeedRows(env);
  if (rows.length === 0) {
    throw new Error('The configured Shopify catalog publication returned no products.');
  }

  return stringify(rows, {
    header: true,
    columns: CSV_COLUMNS,
    bom: true,
    quoted_string: true
  });
}

export async function buildFeedRows(env = process.env, client = createShopifyClient(env)) {
  await validateCatalogConfiguration(env, client);
  const [products, prices] = await Promise.all([
    fetchPublicationProducts(env.SHOPIFY_PUBLICATION_GID, client),
    fetchPriceListPrices(env.SHOPIFY_PRICE_LIST_GID, client)
  ]);

  if (products.length === 0) {
    throw new Error('The configured Shopify catalog publication returned no products.');
  }

  const rows = [];
  for (const product of products) {
    for (const variant of product.variants) {
      const inventoryLevel = summarizeInventoryLevels(variant.inventoryItem?.inventoryLevels?.nodes ?? []);
      rows.push(toCsvRow({ product, variant, inventoryLevel, priceEntry: prices.get(variant.id), env }));
    }
  }

  return rows;
}

async function validateCatalogConfiguration(env, client) {
  const data = await client.graphql(CATALOG_CHECK_QUERY, { catalogId: env.SHOPIFY_CATALOG_GID });
  const catalog = data.catalog;
  if (!catalog) {
    throw new Error(`Shopify catalog was not found: ${env.SHOPIFY_CATALOG_GID}`);
  }

  if (catalog.publication?.id && catalog.publication.id !== env.SHOPIFY_PUBLICATION_GID) {
    throw new Error('SHOPIFY_PUBLICATION_GID does not match the configured catalog publication.');
  }

  if (catalog.priceList?.id && catalog.priceList.id !== env.SHOPIFY_PRICE_LIST_GID) {
    throw new Error('SHOPIFY_PRICE_LIST_GID does not match the configured catalog price list.');
  }
}

async function fetchPublicationProducts(publicationId, client) {
  const products = [];
  let after;

  do {
    const data = await client.graphql(PRODUCTS_QUERY, { publicationId, after });
    const connection = data.publication?.products;
    if (!connection) {
      throw new Error(`Shopify publication was not found or has no products connection: ${publicationId}`);
    }

    for (const edge of connection.edges ?? []) {
      const product = edge.node;
      const variantConnection = product.variants;
      product.variants = [...(variantConnection?.nodes ?? [])];
      if (product.variants.length === 0) continue;

      if (variantConnection?.pageInfo?.hasNextPage) {
        const additionalVariants = await fetchRemainingVariants(product.id, variantConnection.pageInfo.endCursor, client);
        product.variants.push(...additionalVariants);
      }

      for (const variant of product.variants) {
        if (variant.inventoryItem?.inventoryLevels?.pageInfo?.hasNextPage) {
          const additionalLevels = await fetchRemainingInventoryLevels(
            variant.inventoryItem.id,
            variant.inventoryItem.inventoryLevels.pageInfo.endCursor,
            client
          );
          variant.inventoryItem.inventoryLevels.nodes.push(...additionalLevels);
        }
      }

      products.push(product);
    }

    if (connection.pageInfo?.hasNextPage && !connection.pageInfo.endCursor) {
      throw new Error('Shopify product pagination failed: hasNextPage was true but endCursor was missing.');
    }
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : undefined;
  } while (after);

  return products;
}

async function fetchRemainingVariants(productId, after, client) {
  const variants = [];
  let cursor = after;

  while (cursor) {
    const data = await client.graphql(PRODUCT_VARIANTS_QUERY, { productId, after: cursor });
    const connection = data.product?.variants;
    if (!connection) {
      throw new Error(`Shopify variant pagination failed for product ${productId}.`);
    }

    const nodes = connection.nodes ?? [];
    for (const variant of nodes) {
      if (variant.inventoryItem?.inventoryLevels?.pageInfo?.hasNextPage) {
        const additionalLevels = await fetchRemainingInventoryLevels(
          variant.inventoryItem.id,
          variant.inventoryItem.inventoryLevels.pageInfo.endCursor,
          client
        );
        variant.inventoryItem.inventoryLevels.nodes.push(...additionalLevels);
      }
    }
    variants.push(...nodes);

    if (connection.pageInfo?.hasNextPage && !connection.pageInfo.endCursor) {
      throw new Error(`Shopify variant pagination failed for product ${productId}: missing endCursor.`);
    }
    cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : undefined;
  }

  return variants;
}

async function fetchRemainingInventoryLevels(inventoryItemId, after, client) {
  const inventoryLevels = [];
  let cursor = after;

  while (cursor) {
    const data = await client.graphql(INVENTORY_LEVELS_QUERY, { inventoryItemId, after: cursor });
    const connection = data.inventoryItem?.inventoryLevels;
    if (!connection) {
      throw new Error(`Shopify inventory pagination failed for inventory item ${inventoryItemId}.`);
    }

    inventoryLevels.push(...(connection.nodes ?? []));
    if (connection.pageInfo?.hasNextPage && !connection.pageInfo.endCursor) {
      throw new Error(`Shopify inventory pagination failed for inventory item ${inventoryItemId}: missing endCursor.`);
    }
    cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : undefined;
  }

  return inventoryLevels;
}

async function fetchPriceListPrices(priceListId, client) {
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

    if (connection?.pageInfo?.hasNextPage && !connection.pageInfo.endCursor) {
      throw new Error('Shopify price list pagination failed: missing endCursor.');
    }
    after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : undefined;
  } while (after);

  return prices;
}

function toCsvRow({ product, variant, inventoryLevel, priceEntry, env }) {
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
    price_currency: priceEntry?.currency ?? 'EUR',
    compare_at_price: priceEntry?.compareAtPrice ?? variant.compareAtPrice ?? '',
    inventory_item_id: variant.inventoryItem?.id ?? '',
    inventory_tracked: variant.inventoryItem?.tracked ?? '',
    inventory_available: inventoryLevel.quantities.available,
    inventory_on_hand: inventoryLevel.quantities.on_hand,
    inventory_committed: inventoryLevel.quantities.committed,
    inventory_location_id: inventoryLevel.location?.id ?? '',
    inventory_location_name: inventoryLevel.location?.name ?? '',
    image_url: variant.image?.url ?? product.featuredMedia?.preview?.image?.url ?? '',
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
