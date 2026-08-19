# GPL Customizer — Product Data Model

How a product opts into the quick-order customizer and declares its print areas.
This mirrors Printeez's structure: Front / Back / Left Side / Right Side, each with
its own printable zone and per-color mockup.

## 1. Template

Assign the product to the **`customizer`** product template
(Admin → Product → Theme template → `customizer`). Only products on this template
get the quick-order UI.

## 2. Variant structure (required)

Three options, in this exact order:

| Option | Values | Purpose |
|---|---|---|
| `Color` | Black, White, Royal, … | Groups the size grids; one swatch per color |
| `Size` | SM, MD, LG, XL, 2XL, 3XL, 4XL, 5XL | Columns of the quantity grid |
| `# of Print Areas` | `1 Print Area`, `2 Print Areas`, `3 Print Areas`, `4 Print Areas` | Pricing tier — auto-selected from how many areas have artwork. Customers never see this option directly. |

Per-area upcharge is baked into the variant prices (e.g. Black/SM/1 = $18.00,
Black/SM/2 = $23.00). The imported Gildan 5000 CSV already follows this.

## 3. Print areas metafield

Product metafield **`custom.print_areas`** (type: JSON). Defines which areas exist
and where the printable zone sits on the mockup image. Coordinates are fractions
(0–1) of the mockup image's width/height, so any image size works.

```json
{
  "areas": [
    { "name": "Front",      "zone": { "x": 0.30, "y": 0.24, "w": 0.40, "h": 0.46 } },
    { "name": "Back",       "zone": { "x": 0.30, "y": 0.20, "w": 0.40, "h": 0.50 } },
    { "name": "Left Side",  "zone": { "x": 0.38, "y": 0.30, "w": 0.24, "h": 0.20 } },
    { "name": "Right Side", "zone": { "x": 0.38, "y": 0.30, "w": 0.24, "h": 0.20 } }
  ]
}
```

- `name` must be one of: `Front`, `Back`, `Left Side`, `Right Side` (these strings
  also appear in line-item properties on orders).
- Products can declare fewer areas (e.g. mugs: just `Front`).
- If the metafield is missing, the section falls back to a single `Front` area
  with a centered default zone — the product still works.

## 4. Mockup images (per color / per area)

Mockups are regular product images identified by **alt text convention**:

```
mockup:<Color>:<Area>
e.g.  mockup:Black:Front
      mockup:Royal:Back
```

Resolution order when the customizer needs a mockup for (color, area):

1. Product image with alt `mockup:<Color>:<Area>`
2. Product image with alt `mockup:<Color>:Front` (color's front as fallback)
3. The variant image for that color (from the variant's `featured_image`)
4. The product's featured image

So the client can start with zero alt-text work (step 3/4 carries it) and add
proper per-area mockups over time.

## 5. Line-item properties written to every order line

| Property | Example | Visible to customer |
|---|---|---|
| `Print Method` | `DTF` | yes |
| `Print Areas` | `Front, Back` | yes |
| `Artwork — Front` | `https://ucarecdn.com/…/logo.png` | yes |
| `Artwork — Back` | url | yes |
| `Preview — Front` | url of flattened mockup+artwork render | yes |
| `_Placement Front` | `{"x":0.41,"y":0.3,"scale":0.62,"angle":0}` | no (underscore = hidden) |

Every line in a multi-color/multi-size order carries the full set, so staff can
open any line item in Shopify admin and see method + artwork + placement.

## 6. Uploads

Artwork files upload to **Uploadcare** (same service Printeez uses).
Public key lives in the customizer section settings (`upload_public_key`).
Free tier: 3,000 uploads / 3 GB per month. Until a key is configured the
section shows an admin-only warning and keeps add-to-cart disabled.

## 7. Products with more than 250 variants

Liquid (`product.variants`) and `/products/{handle}.js` both return **at most 250
variants**. The Gildan 5000 has 992, so the customizer would otherwise show
colours it has no data for.

Fix: a compact **`custom.variant_map`** JSON metafield (~800 bytes) that the
front end expands into the full catalogue with no API call:

```json
{
  "colors": ["Black", "White", …],       // canonical option order
  "sizes":  ["SM", …],
  "tiers":  ["1 Print Area", …],
  "prices": [[1800,2800,3800,4800], …],  // [sizeIndex][tierIndex] in cents
  "step":   32768,                        // variant ids increment by this
  "runs":   [{"from":0,"to":250,"start":71156992180477},
             {"from":250,"to":992,"start":71158952198397}]
}
```

Variants are created in canonical order (colour → size → tier) and Shopify
assigns sequential ids within a single import, so each import is one "run".
`gpl-customizer.js → expandVariantMap()` rebuilds all 992 entries from this.

**Regenerate the map whenever variants are added, removed, or repriced** —
otherwise the page will offer stale ids. Verify after any change by adding a
late-alphabet colour (e.g. Midnight) to the cart.

Fallback: set a Storefront API token in the section settings and the front end
will page through the live catalogue instead (`hydrateAllVariants()`), which
never goes stale.
