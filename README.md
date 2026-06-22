# Geggamoja Spacefoot B2B Catalog Feed

This repository publishes the Geggamoja Spacefoot / France EUR B2B Shopify catalog as a static `feed.csv` file through **GitHub Pages**. A **GitHub Actions** workflow fetches live data from the Shopify Admin GraphQL API, writes `public/feed.csv`, writes `public/feed-meta.json`, and deploys the `public/` folder to Pages.

No Express server, always-on backend, or local machine is required after setup.

## What it provides

- GitHub Actions workflow that generates `feed.csv`:
  - manually with `workflow_dispatch`
  - automatically every day at **06:00 UTC**
- Shopify credentials loaded only from GitHub Actions secrets.
- Static GitHub Pages supplier dashboard showing:
  - last generation date
  - number of products and variants
  - stock and data-quality KPIs
  - Chart.js visualizations
  - searchable/filterable variant tables
  - a **Download CSV** button
- Shopify Admin GraphQL feed generation with conservative page sizes to avoid Shopify query cost failures.
- CSV output with one row per variant and the same column set used by the prior app.

## Published files

The workflow deploys these files to GitHub Pages:

```text
index.html       # Static supplier dashboard
feed.csv         # Generated catalog feed
feed-meta.json   # Last generation timestamp, product count, row count
feed-history.json              # Daily feed KPI snapshots
feed-changes.json              # Latest product movement summary
product-snapshot.json          # Latest product-level stock snapshot
product-snapshots-history.json # Product-level stock snapshots retained for time ranges
```

## CSV columns

```text
brand, product_id, product_handle, product_title, product_type, product_status,
variant_id, variant_sku, barcode,
option1_name, option1_value, option2_name, option2_value, option3_name, option3_value,
price_amount, price_currency, compare_at_price,
inventory_item_id, inventory_tracked, inventory_available, inventory_on_hand, inventory_committed,
inventory_location_id, inventory_location_name,
image_url, product_url, tags, updated_at
```

## GitHub setup

### 1. Add GitHub Actions secrets

In the GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret** and add the following **secret names** one by one.

Only `SHOPIFY_ADMIN_ACCESS_TOKEN` is a true private credential. The shop/catalog IDs are not passwords, but the workflow still reads them from GitHub Secrets so all runtime configuration is managed in one GitHub screen and nothing needs to be edited in the workflow file.

| GitHub secret name | Value to enter | Is it sensitive? |
| --- | --- | --- |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | example-token-do-not-commit-real-value | **Yes — private credential** |
| `SHOPIFY_SHOP_DOMAIN` | `example-shop.myshopify.com` | No — shop identifier |
| `SHOPIFY_ADMIN_API_VERSION` | `2025-10` | No — API version |
| `SHOPIFY_CATALOG_ID` | `1234567890` | No — catalog identifier |
| `SHOPIFY_CATALOG_GID` | `gid://shopify/Catalog/1234567890` | No — catalog identifier |
| `SHOPIFY_PUBLICATION_GID` | `gid://shopify/Publication/2345678901` | No — publication identifier |
| `SHOPIFY_PRICE_LIST_GID` | `gid://shopify/PriceList/3456789012` | No — price-list identifier |

The `.env.example` file is only a template for optional local testing. It shows the variable names and safe configuration values, but it does **not** contain the real Shopify Admin token. Never commit a real `.env` file.

`SHOPIFY_ADMIN_ACCESS_TOKEN` must only be stored as a GitHub secret. It is never written to `public/`, `feed.csv`, `feed-meta.json`, or frontend JavaScript.

### 2. Enable GitHub Pages from Actions

In the repository, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.

### 3. Run the workflow

Open **Actions → Generate Shopify catalog feed → Run workflow**.

The same workflow also runs every day at **06:00 UTC**:

```yaml
schedule:
  - cron: '0 6 * * *'
```

## Workflow details

The workflow is defined in `.github/workflows/generate-feed.yml` and does the following:

1. Checks out the repository.
2. Installs Node.js dependencies.
3. Runs `npm run generate` with Shopify values from GitHub Secrets.
4. Writes `public/feed.csv` and `public/feed-meta.json`.
5. Uploads `public/` as a GitHub Pages artifact.
6. Deploys the artifact to GitHub Pages.

## Local verification, optional

Local execution is optional. If you want to test before relying on Actions:

```bash
cp .env.example .env
npm install
npm run verify
npm run generate
npm test
```

Generated local output is written to:

```text
public/feed.csv
public/feed-meta.json
```

## Why this no longer needs a server

GitHub Actions is the trusted backend. It receives the Shopify Admin credentials from GitHub Secrets, generates static output files, and publishes only safe files to GitHub Pages. GitHub Pages then serves static HTML/JSON/CSV only, and the browser dashboard parses `feed.csv` locally with PapaParse and renders charts with Chart.js, so there is no server process to host, monitor, or restart.

## Security notes

- Do not commit `.env` or real Shopify tokens.
- Do not add Shopify secrets to `public/index.html` or any other file under `public/`.
- Rotate the Shopify Admin token if it is exposed.
- The generated CSV is public to anyone who can access the GitHub Pages site. If the feed must be private, use a private distribution mechanism instead of public GitHub Pages.
