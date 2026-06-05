# Geggamoja Spacefoot B2B Catalog Feed

Small internal Node.js/Express web app for generating a downloadable CSV feed for the Geggamoja Spacefoot / France EUR B2B Shopify catalog.

The app uses Shopify Admin GraphQL API on the server, reads included products from the configured catalog publication, resolves EUR prices from the configured price list, reads variant inventory levels, and returns one CSV row per variant with inventory quantities summed across inventory locations.

## What it provides

- Password-protected internal web UI.
- `GET /api/feed.csv` endpoint that fetches live Shopify data and returns an Excel/LibreOffice-friendly CSV download.
- Environment-variable based secret management.
- Product, variant, price-list, and inventory-level pagination with conservative Shopify GraphQL page sizes.
- Defensive errors for missing environment variables, Shopify HTTP failures, GraphQL errors, empty catalogs, non-EUR price-list configuration, invalid pagination responses, and Shopify throttle/retry conditions.

## CSV columns

The feed intentionally splits Shopify work into smaller Admin GraphQL queries: publication products are fetched without variants, variants are fetched per product, and inventory levels are fetched per inventory item. Product and variant pages are capped at 25 records, product images are capped at 1 image, and inventory is never nested inside the product query. This avoids Shopify single-query cost failures such as `Query cost ... exceeds the single query max cost limit 1000`.

The CSV includes these columns:

```text
brand, product_id, product_handle, product_title, product_type, product_status,
variant_id, variant_sku, barcode,
option1_name, option1_value, option2_name, option2_value, option3_name, option3_value,
price_amount, price_currency, compare_at_price,
inventory_item_id, inventory_tracked, inventory_available, inventory_on_hand, inventory_committed,
inventory_location_id, inventory_location_name,
image_url, product_url, tags, updated_at
```

## Configure `.env`

Copy the example file and fill in real values:

```bash
cp .env.example .env
```

Required app authentication variables:

```env
APP_PASSWORD=replace-with-a-strong-internal-password
SESSION_SECRET=replace-with-at-least-32-random-characters
```

Required Shopify variables:

```env
SHOPIFY_SHOP_DOMAIN=geggamojab2b.myshopify.com
SHOPIFY_ADMIN_API_VERSION=2025-10
SHOPIFY_ADMIN_ACCESS_TOKEN=replace-with-shopify-admin-access-token
SHOPIFY_CATALOG_ID=88934580363
SHOPIFY_CATALOG_GID=gid://shopify/Catalog/88934580363
SHOPIFY_PUBLICATION_GID=gid://shopify/Publication/186172997771
SHOPIFY_PRICE_LIST_GID=gid://shopify/PriceList/26895024267
```

Notes:

- Use a Shopify Admin API access token with the minimum scopes required to read products, publications/catalogs, price lists, and inventory.
- `SHOPIFY_ADMIN_ACCESS_TOKEN` is only read by server-side code. Do not put it in frontend JavaScript, static HTML, or client-side build variables.
- Use the Spacefoot / France EUR catalog IDs shown above, not the full shop catalog. `SHOPIFY_CATALOG_ID` is optional when `SHOPIFY_CATALOG_GID` is present, but keeping both is useful for human cross-checking.

## Run locally

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm start
```

For development with Node's watch mode:

```bash
npm run dev
```

Run the lightweight unit tests:

```bash
npm test
```

Open <http://localhost:3000>. Unauthenticated visitors are redirected to `/login`. After login, click **Generate CSV** to download the live feed from `/api/feed.csv`; this also keeps an in-memory copy available at `/api/feed/latest.csv` until the server restarts.

You can also verify the Shopify catalog configuration without starting the web app:

```bash
node verify-shopify-catalog.mjs
```

## Deploy safely

- Deploy to a server platform that can run Node.js backend code, such as a private VM, Render, Fly.io, Heroku, Railway, AWS ECS/App Runner, Google Cloud Run, or Azure App Service.
- Configure all secrets in the hosting provider's environment variable / secret manager UI.
- Serve the app over HTTPS only.
- In production, set `NODE_ENV=production`.
- If the app is behind a trusted HTTPS reverse proxy, set `TRUST_PROXY=true` so secure cookies work correctly.
- Restrict access further with VPN, IP allowlists, SSO, or an internal network where possible.
- Rotate `APP_PASSWORD`, `SESSION_SECRET`, and the Shopify Admin token if they are exposed.

## Why GitHub Pages alone is not suitable

GitHub Pages only serves static files. This project needs server-side code to protect `SHOPIFY_ADMIN_ACCESS_TOKEN`, create authenticated sessions, call Shopify Admin GraphQL API, handle pagination and throttling, and stream a generated CSV. Putting the token into a static GitHub Pages frontend would expose the Shopify Admin token to anyone who can view the page source or browser network requests.

## Project structure

```text
src/
  auth.js      # Login, logout, and route guard helpers
  feed.js      # Shopify feed normalization and CSV generation
  server.js    # Express app and routes
  shopify.js   # Shopify Admin GraphQL client and environment validation
public/
  index.html   # Authenticated internal UI
  login.html   # Password login page
```


## Git branch troubleshooting

If `git pull` says `Déjà à jour` / `Already up to date` after Git fetches another branch, your current local branch probably is not tracking that remote branch. Check your current branch with:

```bash
git branch --show-current
```

Then switch to the generated branch explicitly, for example:

```bash
git fetch origin
git checkout codex/create-node.js-express-web-app-for-csv-feed
git pull --ff-only
```

Or, if the branch only exists on the remote:

```bash
git checkout -t origin/codex/create-node.js-express-web-app-for-csv-feed
```
