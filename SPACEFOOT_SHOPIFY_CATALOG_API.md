# Spacefoot Shopify Catalog API Notes

This project uses the Shopify Admin GraphQL API to export the Geggamoja B2B catalog configured for Spacefoot / France EUR.

Required identifiers:

- `SHOPIFY_CATALOG_GID` — the Shopify catalog GID for the Spacefoot catalog.
- `SHOPIFY_PUBLICATION_GID` — the catalog publication used to read only products included in the catalog.
- `SHOPIFY_PRICE_LIST_GID` — the EUR price list attached to the catalog.

The application intentionally does not use Storefront API or scrape the storefront. The Shopify Admin access token must stay on the server and must never be shipped to browser JavaScript.
