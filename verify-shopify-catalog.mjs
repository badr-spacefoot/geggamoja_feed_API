import dotenv from 'dotenv';
import { createShopifyClient, validateShopifyEnv } from './src/shopify.js';

dotenv.config();

const QUERY = `#graphql
  query VerifyCatalog($catalogId: ID!, $publicationId: ID!, $priceListId: ID!) {
    catalog(id: $catalogId) {
      id
      title
      status
      publication { id }
      priceList { id currency }
    }
    publication(id: $publicationId) {
      id
      products(first: 1) {
        nodes { id title handle }
      }
    }
    priceList(id: $priceListId) {
      id
      currency
    }
  }
`;

try {
  validateShopifyEnv(process.env);
  const client = createShopifyClient(process.env);
  const data = await client.graphql(QUERY, {
    catalogId: process.env.SHOPIFY_CATALOG_GID,
    publicationId: process.env.SHOPIFY_PUBLICATION_GID,
    priceListId: process.env.SHOPIFY_PRICE_LIST_GID
  });

  console.log(JSON.stringify(data, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
