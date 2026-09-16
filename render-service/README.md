# Print-file service (customizer Phase 2)

Turns a customizer design into a real print file: **12 × 16 in at 300 DPI = 3600 × 4800 px**,
transparent background, ready for DTF/DTG.

The storefront already attaches a `_Design <Area>` JSON file to every order line. That
JSON stores the artwork in *zone units* (the print area is 1000 units wide), so it is
resolution independent — this service only changes the scale it is drawn at.

## Why it renders in a browser

It runs headless Chromium and loads **`assets/gpl-design-render.js`**, the exact file the
storefront loads. Text metrics, letter spacing and the arc/circle warps are produced by
the same engine that drew the proof the customer approved, so the print file cannot
quietly disagree with it. A separate server-side reimplementation would look close and be
subtly wrong.

That is also why the Docker build context is the repo root: the service must sit inside
the theme repo and read that one shared file.

## Deploy to Railway

1. **New Project → Deploy from GitHub repo** → pick this repo.
2. **Settings → Build**: leave *Root Directory* empty, set *Dockerfile Path* to
   `render-service/Dockerfile`. (`railway.json` already sets this if Railway reads it.)
3. **Variables** — copy from `.env.example`:

   | Variable | Notes |
   |---|---|
   | `RENDER_TOKEN` | any long random string; guards `/render` |
   | `SHOPIFY_WEBHOOK_SECRET` | from the webhook you create in step 5 |
   | `SHOPIFY_SHOP` | `rfa089-71.myshopify.com` |
   | `SHOPIFY_ADMIN_TOKEN` | custom app token, scopes `read_orders`, `write_orders` |
   | `UPLOADCARE_PUBLIC_KEY` | same project the customizer uploads to |
   | `UPLOADCARE_CDN_BASE` | `2nfggcljwz.ucarecd.net` |
   | `PRINT_DPI` | `300` |

4. Deploy, then check `https://<your-app>.up.railway.app/health` returns `{"ok":true}`.
5. **Shopify Admin → Settings → Notifications → Webhooks → Create webhook**
   - Event: *Order creation*, Format: JSON
   - URL: `https://<your-app>.up.railway.app/webhooks/orders/create`
   - Copy the signing secret into `SHOPIFY_WEBHOOK_SECRET` and redeploy.

## What happens on an order

Shopify posts the order. The signature is verified, and for every `_Design <Area>`
property on every line the service renders a full-resolution PNG, uploads it, and writes
the links back onto the order as the `custom.print_files` metafield:

```json
{ "generatedAt": "…", "files": [
  { "lineTitle": "Gildan 5000 | Heavy Cotton T-Shirt", "area": "Front",
    "player": "Smith 23", "url": "https://…/order-1042-…-front-300dpi.png",
    "width": 3600, "height": 4800, "dpi": 300, "calibrated": true }
]}
```

Team orders are handled: a roster line renders with that player's name and number
substituted into the bound text layers, so each player gets their own print file.

## Calibrated vs uncalibrated

A print area only carries real inches when the product's `custom.print_areas` metafield
gives it a `w_in`. Today only the Gildan 5000 does.

- **Calibrated** → rendered at `w_in × 300` px, filename ends `-300dpi`, `dpi: 300`.
- **Uncalibrated** → we know the artwork's proportions but not its printed size, so it is
  rendered at a fixed 3000 px wide, the filename ends `-uncalibrated`, and `dpi` is `null`.

Uncalibrated output is usable but should be treated as "scale to fit the print area".
Adding real print sizes to the other products turns them into true 300 DPI files with no
code change.

## API

```
GET  /health
POST /render                    Authorization: Bearer $RENDER_TOKEN
     { "designUrl": "https://…/design-black-front.json" }
     { "design": {...}, "w_in": 12, "h_in": 16, "dpi": 300, "upload": false }
     → { url, width, height, dpi, calibrated }  (or the raw PNG when upload:false)
POST /webhooks/orders/create    signed by Shopify
```

## Local development

```bash
cd render-service
npm install
npx puppeteer browsers install chrome     # or point at an installed Chrome:
# export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
npm run selftest                          # renders a 3600x4800 test file into out/
npm start
```

`npm run selftest` builds a design that exercises arc-warped text, an outlined number and
a rotated name, renders it at 300 DPI, and asserts the output is a 3600 × 4800 PNG with
real content. Run it after touching `assets/gpl-design-render.js`.

## Notes

- Fonts are downloaded once at boot and cached in `browser/fonts/`, so a render never
  depends on Google Fonts being reachable mid-order. All 18 families are open licence
  (SIL OFL or Apache), which permits commercial print use.
- `MAX_PIXELS` (default 40M) caps one render so a bad payload cannot exhaust memory.
  12 × 16 in at 300 DPI is 17.3M, so normal work is well under it.
- The webhook replies to Shopify immediately and renders afterwards; Shopify retries
  anything slower than five seconds, and a 12 × 16 in file takes about two.
