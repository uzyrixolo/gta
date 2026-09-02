/* GTA Print Lab — quick-order customizer (Alpine component)
   Data contract: see docs/customizer-data-model.md */
window.gplQuickOrder = function (sectionId) {
  // Config is a huge per-product JSON blob (all variants/images/colours). It used to be
  // inlined directly as the x-data attribute value, which silently truncated on any
  // product whose title/description/alt text contained an apostrophe — the HTML parser
  // reads a bare `'` inside a single-quoted attribute as the attribute's closing quote,
  // cutting the payload mid-string ("Men's", "Women's", ...) and leaving Alpine with an
  // unparseable expression (every reactive property undefined, nothing rendered). A
  // <script type="application/json"> element has no such quoting conflict.
  const dataEl = document.getElementById('gpl-cz-data-' + sectionId);
  const config = dataEl ? JSON.parse(dataEl.textContent) : {};
  const fx = { canvas: null, obj: null, ro: null };   // fabric state kept OUT of Alpine's reactive proxy
  return {
    // ---- config ----
    variants: config.variants,        // [{id, color, size, tier, price, available, image}]
    sizes: config.sizes,              // ordered unique sizes
    colors: config.colors,            // [{name, hex, image}]
    areas: config.areas,              // [{name, zone:{x,y,w,h}}]
    isHeadwear: !!config.isHeadwear,  // swaps the STEP 2 area icons from shirt shapes to cap shapes
    mockups: config.mockups,          // {"Color|Area": url}
    fallbackImage: config.fallbackImage,
    uploadKey: config.uploadKey || '',
    cdnBase: (config.cdnBase || 'ucarecdn.com').replace(/^https?:\/\//,'').replace(/\/$/,''),
    methods: config.methods,          // [{name, description}]

    // ---- state ----
    openColors: [],
    showAddColor: false,
    qty: {},                          // "Color|Size" -> int
    artwork: {},                      // "Color|Area" -> {url, filename, localUrl, uploading} — each colour uploads its own
    placement: {},                    // "Color|Area" -> {x,y,scale,angle} (filled by editor task)
    activeColor: config.colors.length ? config.colors[0].name : '',
    previewColorName: null,
    activePrintArea: config.areas.length ? config.areas[0].name : 'Front',
    methodByColor: {},                // "Color" -> method name; each colour picks its own technique
    designerNotes: '',
    submitting: false,
    errorMsg: '',
    _previewTimer: null,

    init() {
      this.buildMockupMap(config.images || []);
      // Liquid caps at 250 variants. Preferred fix: expand the compact variant map
      // metafield (no API call). Fallback: Storefront API when a token is configured.
      if (!this.expandVariantMap(config.variantMap)
          && config.storefrontToken
          && (config.allColorNames || []).length > this.colors.length) {
        this.hydrateAllVariants();
      }
      this.restore();
      this.$watch('qty', () => this.persist());
      this.$watch('artwork', () => this.persist());
      // default selection guards: a valid color must always be active with its grid open
      const names = this.colors.map(c => c.name);
      this.openColors = this.openColors.filter(c => names.includes(c));
      if (!names.includes(this.activeColor)) this.activeColor = names[0] || '';
      // honour Shopify's ?variant= URL (deep links / campaigns select that colour)
      const vid = new URLSearchParams(location.search).get('variant');
      if (vid) {
        const v = this.variants.find(x => String(x.id) === String(vid));
        if (v && names.includes(v.color)) {
          this.activeColor = v.color;
          if (!this.openColors.includes(v.color)) this.openColors.unshift(v.color);
        }
      }
      if (!this.openColors.length && names.length) this.openColors = [names[0]];
      if (!this.openColors.includes(this.activeColor) && this.openColors.length) this.activeColor = this.openColors[0];
      this.$nextTick(() => this.initFabric());
      this.$watch('activePrintArea', () => this.loadAreaIntoFabric());
      this.$watch('activeColor', () => this.loadAreaIntoFabric());
      window.addEventListener('gpl:artwork-changed', () => this.loadAreaIntoFabric());
      // belt-and-suspenders: flush to localStorage the moment the tab is hidden or
      // closed, so a mid-edit navigation away never drops an in-flight change.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.persist();
      });
      window.addEventListener('pagehide', () => this.persist());
    },

    // ================= Fabric.js live editor =================
    stageEl() { return this.$root.querySelector('[data-gpl-stage]'); },
    zonePx(areaName) {
      const stage = this.stageEl();
      const a = this.areas.find(x => x.name === areaName);
      if (!stage || !a) return null;
      const W = stage.clientWidth, H = stage.clientHeight;
      return { x: a.zone.x * W, y: a.zone.y * H, w: a.zone.w * W, h: a.zone.h * H };
    },
    initFabric() {
      if (!window.fabric) return;
      const el = this.$refs.fcanvas;
      const stage = this.stageEl();
      if (!el || !stage) return;
      fx.canvas = new fabric.Canvas(el, { selection: false, preserveObjectStacking: true });
      const size = () => {
        fx.canvas.setWidth(stage.clientWidth);
        fx.canvas.setHeight(stage.clientHeight);
        fx.canvas.calcOffset();
        this.loadAreaIntoFabric();
      };
      size();
      fx.ro = new ResizeObserver(() => size());
      fx.ro.observe(stage);
      const clamp = (o) => {
        const z = this.zonePx(this.activePrintArea);
        if (!z) return;
        const b = o.getBoundingRect(true, true);
        if (b.width > z.w || b.height > z.h) {
          const s = Math.min(z.w / b.width, z.h / b.height);
          o.scaleX *= s; o.scaleY *= s;
        }
        const nb = o.getBoundingRect(true, true);
        let dx = 0, dy = 0;
        if (nb.left < z.x) dx = z.x - nb.left;
        if (nb.top < z.y) dy = z.y - nb.top;
        if (nb.left + nb.width > z.x + z.w) dx = (z.x + z.w) - (nb.left + nb.width);
        if (nb.top + nb.height > z.y + z.h) dy = (z.y + z.h) - (nb.top + nb.height);
        o.left += dx; o.top += dy;
        o.setCoords();
      };
      fx.canvas.on('object:moving', e => clamp(e.target));
      fx.canvas.on('object:scaling', e => clamp(e.target));
      fx.canvas.on('object:modified', e => { clamp(e.target); this.savePlacement(); fx.canvas.requestRenderAll(); });
      this.loadAreaIntoFabric();
    },
    loadAreaIntoFabric() {
      if (!fx.canvas) return;
      fx.canvas.clear();
      fx.obj = null;
      const area = this.activePrintArea;
      const color = this.activeColor;
      const artKey = this.key(color, area);
      const art = this.artwork[artKey];
      if (!art || !(art.localUrl || art.url)) { fx.canvas.requestRenderAll(); return; }
      const src = art.localUrl || art.url;
      fabric.Image.fromURL(src, (img) => {
        if (!img || this.activePrintArea !== area || this.activeColor !== color) return;
        const z = this.zonePx(area);
        if (!z) return;
        const p = this.placement[artKey];
        if (p && p.w) {
          img.scaleToWidth(p.w * z.w);
          img.set({ left: z.x + p.cx * z.w, top: z.y + p.cy * z.h, angle: p.angle || 0, originX: 'center', originY: 'center' });
        } else {
          const s = Math.min((z.w * 0.85) / img.width, (z.h * 0.85) / img.height);
          img.scale(s);
          img.set({ left: z.x + z.w / 2, top: z.y + z.h / 2, originX: 'center', originY: 'center' });
        }
        img.set({
          cornerColor: '#D71920', cornerStrokeColor: '#FFFFFF', borderColor: '#D71920',
          cornerSize: 11, transparentCorners: false, lockScalingFlip: true,
        });
        img.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
        fx.obj = img;
        fx.canvas.add(img);
        fx.canvas.setActiveObject(img);
        fx.canvas.requestRenderAll();
        this.savePlacement();
      }, { crossOrigin: 'anonymous' });
    },
    savePlacement() {
      if (!fx.obj) return;
      const z = this.zonePx(this.activePrintArea);
      if (!z) return;
      this.placement[this.key(this.activeColor, this.activePrintArea)] = {
        cx: (fx.obj.left - z.x) / z.w,
        cy: (fx.obj.top - z.y) / z.h,
        w: (fx.obj.getScaledWidth()) / z.w,
        angle: Math.round(fx.obj.angle || 0),
      };
      this.persist();
    },

    // Match product image filenames to colors: "1200W-625-Royal-12-...FlatFront3.jpg",
    // "sport_grey_fornt.jpg", "T-Shirt_Maroon_LS.jpg" etc. Alt "Front"/"Back"/
    // "Left Side"/"Right Side" picks the area; explicit "mockup:Color:Area" alts
    // (this.mockups) always win.
    buildMockupMap(images) {
      const alias = {
        'gold': ['oldgold'], 'safety orange': ['sorange'], 'forest green': ['forestgrn'],
        'graphite heather': ['gphheather'], 'carolina blue': ['carolinabl'],
        'irish green': ['irishgreen'], 'light blue': ['lightblue', 'sky'],
        'sport grey': ['sportgrey', 'sport_grey'], 'dark heather': ['darkheather', 'dark_heather'],
        'cardinal red': ['cardinalrd'], 'texas orange': ['txorange', 'texasorange'],
        'yellow haze': ['yellowhaze'], 'dark chocolate': ['darkchocolate', 'dkchocolate', 'dkchoc'],
        'military green': ['militarygrn', 'militarygreen', 'milgreen'], 'heliconia': ['heliconia'],
      };
      const viewByAlt = { front: 'Front', back: 'Back', 'left side': 'Left Side', 'right side': 'Right Side' };
      const norm = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');
      for (const img of images) {
        // Shopify's Liquid `image.alt` silently falls back to the product title when
        // no alt text is set on the image — it's never actually blank. Only accept
        // images explicitly tagged exactly one of the four view names as clean
        // per-colour photos, so an untagged lifestyle shot (alt == product title)
        // can never win a colour|view slot over the real photo (e.g. "YOUR DESIGN
        // HERE" baked into a hero shot's pixels beating out the genuine blank
        // "black_front" photo).
        const altRaw = (img.alt || '').trim().toLowerCase();
        const view = viewByAlt[altRaw];
        if (!view) continue;
        const fname = norm((img.src.split('/').pop() || '').split('?')[0]);
        for (const c of this.colors) {
          const keys = [norm(c.name)].concat((alias[c.name.toLowerCase()] || []).map(norm));
          if (keys.some(k => k && fname.includes(k))) {
            const mapKey = c.name + '|' + view;
            if (!this.mockups[mapKey]) this.mockups[mapKey] = img.src;
          }
        }
      }
      // per-color fallback image from variants
      this.colors.forEach(c => {
        if (!c.image) c.image = (this.variants.find(v => v.color === c.name && v.image) || {}).image || null;
      });

      // Headwear catalogue images are named "{assetId}_f_fm.jpg" / "_b_fm.jpg" /
      // "_d_fm.jpg" (front/back/detail-side) per colour, with no colour name in the
      // filename at all — the text-matching above can never pair them to a colour.
      // But each colour's variant.image already points at its "_f" shot (Shopify
      // tracks that correctly), so the asset-id prefix from THAT one photo is enough
      // to find its front/back/side siblings directly, with no alt-text tagging needed.
      if (this.isHeadwear) {
        const bySrc = new Map(images.map(img => [img.src, img]));
        for (const c of this.colors) {
          const frontSrc = c.image || (this.variants.find(v => v.color === c.name && v.image) || {}).image;
          if (!frontSrc) continue;
          const fname = (frontSrc.split('/').pop() || '').split('?')[0];
          const m = fname.match(/^(.+)_f(_fm)?\.[a-z]+$/i);
          if (!m) continue;
          const prefix = m[1];
          const frontKey = c.name + '|Front';
          if (!this.mockups[frontKey]) this.mockups[frontKey] = frontSrc;
          for (const img of images) {
            const iname = (img.src.split('/').pop() || '').split('?')[0];
            if (iname.startsWith(prefix + '_d')) {
              const k = c.name + '|Side';
              if (!this.mockups[k]) this.mockups[k] = img.src;
            } else if (iname.startsWith(prefix + '_b')) {
              const k = c.name + '|Back';
              if (!this.mockups[k]) this.mockups[k] = img.src;
            }
          }
        }
      }
    },

    // Rebuild every variant from the compact map written by the build script.
    // Variant ids are sequential within import runs, so 992 variants fit in <1KB.
    expandVariantMap(map) {
      if (!map || !map.colors || !map.runs) return false;
      const idAt = (i) => {
        for (const r of map.runs) if (i >= r.from && i < r.to) return r.start + (i - r.from) * map.step;
        return null;
      };
      const out = [];
      const nS = map.sizes.length, nT = map.tiers.length;
      for (let c = 0; c < map.colors.length; c++) {
        for (let s = 0; s < nS; s++) {
          for (let t = 0; t < nT; t++) {
            const idx = c * nS * nT + s * nT + t;
            const id = idAt(idx);
            if (!id) continue;
            out.push({
              id, color: map.colors[c], size: map.sizes[s], tier: map.tiers[t],
              price: map.prices[s][t], available: true, image: null,
            });
          }
        }
      }
      if (out.length <= this.variants.length) return false;
      this.variants = out;
      this.sizes = map.sizes.slice();
      this.colors = map.colors.map(n => ({ name: n, hex: '', image: null }));
      this.buildMockupMap(config.images || []);
      return true;
    },

    // Pull the complete variant catalogue (products >250 variants) via Storefront API.
    async hydrateAllVariants() {
      const q = `query($handle:String!,$cursor:String){product(handle:$handle){variants(first:250,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id title availableForSale price{amount} selectedOptions{name value}}}}}`;
      let cursor = null, all = [], guard = 0;
      try {
        do {
          const res = await fetch('/api/2024-10/graphql.json', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Shopify-Storefront-Access-Token': config.storefrontToken,
            },
            body: JSON.stringify({ query: q, variables: { handle: config.productHandle, cursor } }),
          });
          if (!res.ok) return;
          const j = await res.json();
          const conn = j && j.data && j.data.product && j.data.product.variants;
          if (!conn) return;
          all = all.concat(conn.nodes);
          cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
        } while (cursor && ++guard < 12);
      } catch (e) { return; }
      if (!all.length) return;
      const opt = (v, name) => (v.selectedOptions.find(o => o.name === name) || {}).value;
      const mapped = all.map(v => ({
        id: Number(String(v.id).split('/').pop()),
        color: opt(v, 'Color'),
        size: opt(v, 'Size'),
        tier: opt(v, '# of Print Areas'),
        price: Math.round(parseFloat(v.price.amount) * 100),
        available: v.availableForSale,
        image: null,
      })).filter(v => v.color && v.size);
      if (mapped.length <= this.variants.length) return;
      this.variants = mapped;
      const names = [];
      mapped.forEach(v => { if (!names.includes(v.color)) names.push(v.color); });
      this.colors = names.map(n => ({ name: n, hex: '', image: null }));
      this.buildMockupMap(config.images || []);
    },

    // ---- variant resolution ----
    tierName(n) { return n <= 1 ? '1 Print Area' : n + ' Print Areas'; },
    // # of print areas that have their own uploaded artwork, for ONE colour —
    // each colour prices by its own coverage, since colours no longer share art.
    areasUsedFor(color) {
      return this.areas.filter(a => {
        const art = this.artwork[this.key(color, a.name)];
        return art && art.url;
      }).length;
    },
    areasUsed() { return this.areasUsedFor(this.activeColor); },
    findVariant(color, size, tier) {
      return this.variants.find(v => v.color === color && v.size === size && v.tier === tier);
    },
    resolvedVariant(color, size) {
      // Print-area-tiered pricing needs a third "# of Print Areas" variant option,
      // which only the original flagship product actually has — every other product
      // in this catalog has just Color/Size, so v.tier is null on every variant and
      // a tier-name lookup ("1 Print Area", ...) can never match anything. Without
      // this fallback every size shows "out of stock" and nothing can be added to
      // cart on any product outside the flagship one.
      const hasTiers = this.variants.some(v => v.tier != null);
      if (!hasTiers) {
        return this.variants.find(v => v.color === color && v.size === size);
      }
      const tier = this.tierName(Math.max(1, this.areasUsedFor(color)));
      return this.findVariant(color, size, tier) || this.findVariant(color, size, '1 Print Area');
    },
    priceFor(color, size) {
      const v = this.resolvedVariant(color, size);
      return v ? v.price : null;
    },
    availableFor(color, size) {
      const v = this.resolvedVariant(color, size);
      return !!(v && v.available);
    },

    // ---- colors ----
    // Every colour-name token seen across the S&S-sourced catalogue (Gildan, Comfort
    // Colors, Richardson/Yupoong, Sport-Tek/Team365, Under Armour, Columbia, Harriton,
    // camo/Realtree patterns, ...). Two/three-tone names ("Black/ White", "Navy/ Red/
    // Black") are looked up token-by-token by hexTokensFor() below, not as one string.
    colorHex: {
      'acid black': '#1C1C1C', 'aluminum': '#A9ACB6', 'amber gold': '#C68E17', 'antique cherry red': '#8E2A34',
      'antique gold': '#B8892F', 'antique heliconia': '#C6407A', 'antique irish green': '#1F7A50',
      'antique jade dome': '#2C8E7C', 'antique orange': '#C4622C', 'antique sapphire': '#1D5C86',
      'apricot': '#FBCEB1', 'aqua': '#00C4CC', 'aquatic': '#2E9CB8', 'army olive green': '#565A3B',
      'ash': '#E5E4DF', 'ash grey': '#B2AFA9', 'asphalt': '#4A4D4F', 'athletic heather': '#B5B2AC',
      'azalea': '#F65275', 'baby blue': '#89CFF0', 'ballerina': '#F4C2C2', 'banana': '#F6E27A', 'bay': '#8C7B6B',
      'berry': '#7A3450', 'birch': '#DCCFB0', 'black': '#1A1A1A', 'black denim': '#22262C',
      'black heather': '#3A3A3A', 'blackberry': '#4A2E42', 'blaze orange': '#FF6600', 'blossom': '#E8B7C4',
      'blue': '#2255A4', 'blue dusk': '#4B5D77', 'blue jean': '#6C89A3', 'blue lagoon': '#2E86AB',
      'blue spruce': '#4A6670', 'blush': '#E8C2C0', 'body blush': '#E8B9A8', 'bone': '#E4DAC4',
      'bottle': '#2E4A3E', 'brick': '#9E4B3F', 'brown': '#5B4636', 'brown duck': '#8A6B45',
      'brown savana': '#6B5842', 'burgundy': '#5C1A2B', 'butter': '#F5E6A0', 'camel': '#C19A6B', 'camo': '#5C5E42',
      'camo green': '#556B4F', 'canada flag': '#D80621', 'caramel': '#AF6E4D', 'cardinal': '#A6192E',
      'cardinal red': '#8A1538', 'carmel': '#AF6E4D', 'carolina blue': '#7BA4DB', 'castlerock': '#8C8479',
      'chalky mint': '#A7D8C4', 'chambray': '#8CA4B8', 'charcoal': '#4A4A4A', 'charcoal heather': '#545454',
      'cherry red': '#AC2B37', 'chill': '#B9D6E0', 'china blue': '#4A79A5', 'city grey': '#8E8E8E',
      'city grey heather': '#9B9B9B', 'clay': '#9C6B4E', 'clear mint': '#8FD8C0', 'clear sky': '#7FB8DE',
      'cobalt': '#0047AB', 'coffee': '#4B3621', 'collegiate navy': '#13294B', 'columbia blue': '#8FC1E3',
      'concrete': '#8C8C87', 'cool blue': '#5B9BD5', 'cool grey': '#A6A6A0', 'coral silk': '#F08A6C',
      'cornsilk': '#F5E7B8', 'court green': '#3E8E5A', 'coyote brown': '#7A5C3E', 'cranberry': '#8E2A44',
      'cream': '#FFFDD0', 'crimson': '#A6192E', 'crunchberry': '#8B7D6B', 'cs grey light heather': '#C4C4C0',
      'daisy': '#F7C63F', 'dark charcoal': '#333333', 'dark chocolate': '#3B2B24', 'dark green': '#1B3B2A',
      'dark green heather': '#2C4A3A', 'dark grey': '#58595B', 'dark grey heather': '#5C5C5C',
      'dark heather': '#5B5A5F', 'dark heather grey': '#54514F', 'dark navy': '#1A2138',
      'dark nocturnal': '#26282B', 'dark stone': '#6E6659', 'denim': '#6E7F91', 'denim blue': '#5C7185',
      'desert beige': '#D8C7A8', 'desert pink': '#E8A3AE', 'dusk': '#5A5B72', 'dusty green': '#7C8B6F',
      'dusty rose': '#C9878F', 'electric green': '#00E64D', 'emerald': '#0E7C5A', 'emerald green': '#0E7C5A',
      'espresso': '#3B2A20', 'evergreen': '#1F4739', 'flo blue': '#3A7CA5', 'forest': '#1E3B2C',
      'forest green': '#1E3B2C', 'fossil': '#8E8877', 'fresh olive': '#6F7A45', 'garnet': '#6E2639',
      'gold': '#F2A93B', 'gold glint': '#D4AF37', 'granite': '#5A4E42', 'granite heather': '#655A4E',
      'grape': '#5E3A6E', 'graphite': '#4B4B4B', 'graphite black': '#292929', 'graphite heather': '#707372',
      'gravel': '#8C8880', 'gray': '#8C8C8C', 'green': '#2E7D32', 'green camo': '#556B4F', 'grey': '#8C8C8C',
      'grey three': '#7C7C7C', 'grill': '#787878', 'heather': '#B0B0B0', 'heather berry': '#8A4A62',
      'heather brown': '#6C5647', 'heather cardinal': '#8D3A46', 'heather cardinal red': '#8D3A46',
      'heather charcoal': '#565656', 'heather dark green': '#2E4A38', 'heather dark grey': '#5A5A5A',
      'heather dark maroon': '#5C333F', 'heather dark navy': '#232B48', 'heather dark royal': '#2C4F8C',
      'heather deep royal': '#26468C', 'heather galapagos blue': '#2E6E8C', 'heather grey': '#B3B3B3',
      'heather heliconia': '#D9598A', 'heather indigo': '#3E4E82', 'heather irish green': '#3E8E63',
      'heather kelly': '#3E8E63', 'heather maroon': '#6E3C48', 'heather military green': '#63644E',
      'heather navy': '#2B3552', 'heather orange': '#E07A3C', 'heather purple': '#5B4A78',
      'heather radiant orchid': '#B067A4', 'heather red': '#B7454A', 'heather royal': '#3E64B0',
      'heather sapphire': '#3C7CA6', 'heather scarlet red': '#B04A50', 'heavy metal': '#4C4C4C',
      'heliconia': '#E24585', 'hemp': '#8C8060', 'hickory heather': '#6E5B4B', 'hot pink': '#FF69B4',
      'hydrangea': '#8CA9C9', 'ice blue': '#CFE8F3', 'ice grey': '#D6D6D2', 'icy rock': '#B7C4C6',
      'indigo': '#3F5FAE', 'indigo blue': '#38508C', 'indigo denim': '#33465F', 'iris': '#5B4E8C',
      'irish green': '#00A65E', 'island reef': '#3FA79A', 'ivory': '#FFFFF0', 'jade dome': '#2FA894',
      'kelly': '#00805E', 'kelly green': '#00805E', 'khaki': '#C3B091', 'khaki brown': '#8A7256',
      'kiwi': '#8CC63F', 'lagoon': '#2E8B9E', 'late night blue': '#22304A', 'latte': '#C8AD8D',
      'lavender': '#C9A6DC', 'lieutenant': '#4B4E52', 'light blue': '#A3C6E8', 'light green': '#A8D5A0',
      'light grey': '#D3D3D3', 'light heather': '#C9C9C9', 'light heather grey': '#C7C7C7',
      'light olive': '#8B8A5A', 'light pink': '#F4C3CE', 'light steel': '#AEB9C4', 'lilac': '#C8A4D4',
      'lime': '#B7D433', 'loden': '#4B5544', 'maroon': '#5B2B38', 'mauve': '#B784A7', 'mauvelous': '#EF98AA',
      'melange charcoal': '#565656', 'melange silver': '#C9C9C9', 'metro blue': '#325A80', 'midnight': '#1F2A44',
      'midnight navy': '#141B33', 'military green': '#5A5B45', 'mint green': '#98D9BB', 'mod grey': '#B7B7B7',
      'moss': '#6B705C', 'moss green': '#6B7A4C', 'mossy oak breakup': '#5B5136', 'mossy oak country': '#585034',
      'mossy oak new breakup - mo15': '#585034', 'multicam alpine': '#7B93A0', 'multicam arid': '#B5A17E',
      'multicam black': '#26241F', 'multicam green': '#59573E', 'multicam tropic': '#4A5D3B', 'mustard': '#C6A038',
      'natural': '#EFE8D8', 'natural heather': '#D9D2C2', 'navy': '#1D2545', 'navy heather': '#2B3552',
      'neon blue': '#2D8CFF', 'neon cantaloupe': '#FFAD60', 'neon fuchsia': '#FF2AA1', 'neon green': '#39FF14',
      'neon lemon': '#F1FF6B', 'neon orange': '#FF6A00', 'neon pink': '#FF3FA4', 'neon purple': '#B24BF3',
      'neon violet': '#B24BF3', 'neon yellow': '#F5FF3D', 'oak': '#8B6E4E', 'oatmeal': '#DCD0B8',
      'off black': '#2B2B2B', 'off white': '#F5F1E8', 'old gold': '#CBA135', 'olive': '#5E5A3F',
      'ombre blue': '#3E6FA1', 'orange': '#F26322', 'orchid': '#B569A6', 'paragon': '#6B7D8C', 'peachy': '#F5C6A5',
      'pepper': '#5C5347', 'periwinkle': '#8E99D6', 'pink': '#F3ABC1', 'pistachio': '#9DC183',
      'pitch black': '#0D0D0D', 'pitch grey': '#3D3D3D', 'poseidon black': '#1B1E22', 'powder blue': '#B0DCEE',
      'power red': '#C81E3A', 'purple': '#3E2B56', 'purple rush': '#5A2D82', 'raspberry': '#B22F63',
      'real coral': '#E9755B', 'realtree all purpose': '#5B5236', 'realtree edge': '#5A4A38',
      'realtree max4': '#54503C', 'realtree max7': '#4C4535', 'red': '#C8102E', 'red river clay': '#9C4B3A',
      'royal': '#1F4E9C', 'royal blue': '#204FA3', 'royal blue heather': '#3E64B0', 'royal pine': '#1F4A3A',
      'rustic orange': '#B5602A', 'safety green': '#C6FF00', 'safety orange': '#FF6D00', 'safety pink': '#FF6FAE',
      'safety yellow': '#EEFF41', 'sage': '#8A9A7B', 'saltwater': '#7FB2C9', 'sand': '#D6CCB2',
      'sandstone': '#D9C9A8', 'sapphire': '#0077B5', 'scarlet': '#B22234', 'sea blue': '#3C7A9E',
      'seafoam': '#93E9BE', 'shiitake': '#9C8F7C', 'silver': '#C0C0C0', 'silver grey': '#BFC1C2', 'sky': '#87CEEB',
      'sky blue': '#76D6FF', 'slate blue': '#5A6E8C', 'smoke blue': '#7C9AAE', 'sport athletic gold': '#B8860B',
      'sport dark navy': '#182038', 'sport dark navy heather': '#28304D', 'sport forest': '#2E4A38',
      'sport forest heather': '#2E4A38', 'sport graphite': '#54595B', 'sport grey': '#9EA0A3',
      'sport light blue': '#9FC4E8', 'sport maroon': '#611F31', 'sport maroon heather': '#5C2A38',
      'sport orange': '#E8621E', 'sport purple': '#5A3E82', 'sport red': '#C8102E', 'sport red heather': '#A33B3B',
      'sport royal': '#2354AC', 'sport royal heather': '#3E63AC', 'spruce': '#3B4F41', 'steel blue': '#4682B4',
      'stone': '#B5AC9A', 'stone blue': '#7C93A3', 'stone grey': '#9A9488', 'stonewash denim': '#7089A0',
      'sunset': '#F4795B', 'tahiti blue': '#2FA4C9', 'tan': '#D2B48C', 'tangerine': '#F28500', 'teal': '#1D8A8A',
      'team navy blue': '#14213E', 'team royal blue': '#2354AC', 'tennessee orange': '#F77F2C',
      'terracotta': '#B15533', 'texas orange': '#B4552D', 'tropical blue': '#3FA9C9', 'true navy': '#202844',
      'turf green': '#3E7A3E', 'turquoise': '#30D5C8', 'tweed': '#8A8272', 'utility green': '#5C6650',
      'vegas gold': '#B79A54', 'veil wideland': '#5E5A44', 'violet': '#8D6CAB', 'vivid blue': '#2E6FD9',
      'warm grey': '#948B84', 'washed denim': '#5F7A8E', 'watermelon': '#E8546C', 'white': '#FFFFFF',
      'white realtree ap': '#D9D4C4', 'wine': '#4E2129', 'yam': '#C77B4C', 'yellow': '#FFD700',
      'yellow haze': '#F5E1A4',
    },
    // Multi-tone names ("Black/ White", "Navy/ Red/ Black") -> array of hexes, one per
    // token, each resolved independently. Falls back to the flat grey for any token this
    // map doesn't recognise yet, rather than losing the whole swatch to grey.
    hexTokensFor(name) {
      return (name || '').split('/').map(s => s.trim().toLowerCase()).filter(Boolean)
        .map(tok => this.colorHex[tok] || '#C4C4C4');
    },
    // resolve a colour to a single hex for SVG clip art (first token of a multi-tone name)
    hexFor(name) {
      const c = this.swatch(name) || {};
      if (c.hex) return c.hex;
      return this.hexTokensFor(name)[0] || '#C4C4C4';
    },
    // which clip-art shape a print area uses
    artShape(areaName) {
      const n = (areaName || '').toLowerCase();
      if (this.isHeadwear) {
        if (n.includes('side')) return 'cap-side';
        if (n.includes('back')) return 'cap-back';
        return 'cap-front';
      }
      if (n.includes('left')) return 'sleeve-left';
      if (n.includes('right')) return 'sleeve-right';
      if (n.includes('back')) return 'back';
      return 'front';
    },
    // clip-art path data (templates can't be used inside <svg>)
    shapePath(areaName) {
      const s = this.artShape(areaName);
      if (s === 'sleeve-left' || s === 'sleeve-right') {
        return 'M42 10 h16 a6 6 0 0 1 6 6 l6 68 a4 4 0 0 1 -4 4 h-32 a4 4 0 0 1 -4 -4 l6 -68 a6 6 0 0 1 6 -6 z';
      }
      if (s === 'back') {
        return 'M32 14 L18 20 L8 36 L19 44 L26 36 L26 88 L74 88 L74 36 L81 44 L92 36 L82 20 L68 14 C63 19 37 19 32 14 Z';
      }
      // Cap dome + brim, viewed head-on: rounded crown sitting on a curved brim.
      if (s === 'cap-front' || s === 'cap-back') {
        return 'M18 58 C18 28 32 12 50 12 C68 12 82 28 82 58 L82 63 C82 69 66 72 50 72 C34 72 18 69 18 63 Z';
      }
      // Cap side profile: crown with a brim projecting to the left.
      if (s === 'cap-side') {
        return 'M38 14 C56 14 70 26 72 44 L88 48 C92 49 92 55 88 56 L70 60 C66 68 56 74 42 74 C26 74 14 66 12 52 C10 38 20 20 38 14 Z';
      }
      return 'M32 14 L18 20 L8 36 L19 44 L26 36 L26 88 L74 88 L74 36 L81 44 L92 36 L82 20 L68 14 C63 23 37 23 32 14 Z';
    },
    collarPath(areaName) {
      const s = this.artShape(areaName);
      if (s === 'front') return 'M32 14 C37 23 63 23 68 14';
      if (s === 'back') return 'M33 15 C38 20 62 20 67 15';
      if (s === 'cap-front' || s === 'cap-back') return 'M18 58 C30 63 70 63 82 58';
      return '';
    },
    shapeTransform(areaName) {
      return this.artShape(areaName) === 'sleeve-right' ? 'translate(100,0) scale(-1,1)' : '';
    },

    // light garments need a visible outline
    isLight(name) {
      const h = this.hexFor(name).replace('#', '');
      if (h.length !== 6) return false;
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      return (0.299 * r + 0.587 * g + 0.114 * b) > 200;
    },
    swatchStyle(name) {
      const c = this.swatch(name) || {};
      if (c.hex) return 'background-color:' + c.hex;
      const hexes = this.hexTokensFor(name);
      if (hexes.length <= 1) return 'background-color:' + (hexes[0] || '#C4C4C4');
      // Two/three-tone colourway ("Black/ White", "Navy/ Red/ Black") — split the
      // swatch into even wedges instead of collapsing to one flat grey circle.
      const step = 100 / hexes.length;
      const stops = hexes.map((h, i) => h + ' ' + (i * step) + '%, ' + h + ' ' + ((i + 1) * step) + '%');
      return 'background-image: linear-gradient(90deg, ' + stops.join(', ') + ');';
    },
    swatch(color) { return this.colors.find(c => c.name === color); },
    // ---- printing technique (per colour) ----
    methodFor(colorName) {
      return this.methodByColor[colorName] || (this.methods[0] && this.methods[0].name) || '';
    },
    setMethod(colorName, name) {
      this.methodByColor[colorName] = name;
      this.persist();
    },
    toggleColor(name) {
      if (this.openColors.includes(name)) { this.activeColor = name; this.syncVariantUrl(); return; }
      this.openColors.push(name);
      this.activeColor = name;
      this.syncVariantUrl();
    },
    syncVariantUrl() {
      const v = this.resolvedVariant(this.activeColor, this.sizes[0]);
      if (!v) return;
      const u = new URL(location.href);
      u.searchParams.set('variant', v.id);
      history.replaceState({}, '', u);
    },
    removeColor(name) {
      this.openColors = this.openColors.filter(c => c !== name);
      const prefix = name + '|';
      Object.keys(this.qty).forEach(k => { if (k.startsWith(prefix)) delete this.qty[k]; });
      Object.keys(this.artwork).forEach(k => { if (k.startsWith(prefix)) delete this.artwork[k]; });
      Object.keys(this.placement).forEach(k => { if (k.startsWith(prefix)) delete this.placement[k]; });
      delete this.methodByColor[name];
      if (this.activeColor === name) this.activeColor = this.openColors[0] || '';
      this.persist();
    },
    previewColor(name) { clearTimeout(this._previewTimer); this.previewColorName = name; },
    resetPreviewColor() { this._previewTimer = setTimeout(() => (this.previewColorName = null), 350); },

    // ---- mockups ----
    mockupFor(color, area) {
      return this.mockups[color + '|' + area]
        || this.mockups[color + '|Front']
        || (this.swatch(color) || {}).image
        || this.fallbackImage;
    },
    currentMockup() {
      return this.mockupFor(this.previewColorName || this.activeColor, this.activePrintArea);
    },

    // ---- quantities / totals ----
    key(color, size) { return color + '|' + size; },
    setQty(color, size, val) {
      const n = Math.max(0, parseInt(val || 0, 10) || 0);
      if (n === 0) delete this.qty[this.key(color, size)];
      else this.qty[this.key(color, size)] = n;
    },
    totalUnits() { return Object.values(this.qty).reduce((a, b) => a + b, 0); },
    totalPrice() {
      let cents = 0;
      for (const k in this.qty) {
        const [color, size] = k.split('|');
        const v = this.resolvedVariant(color, size);
        if (v) cents += v.price * this.qty[k];
      }
      return cents;
    },
    money(cents) {
      if (cents == null) return '';
      return '$' + (cents / 100).toFixed(2);
    },

    // ---- artwork upload (Uploadcare REST) ----
    hasArtworkFor(color) { return this.areasUsedFor(color) > 0; },
    // Every open colour must have its own artwork before checkout — colours no
    // longer share a single upload.
    hasArtwork() { return this.openColors.length > 0 && this.openColors.every(c => this.hasArtworkFor(c)); },
    // Phone photos are routinely 4000px+ / 5-15MB, which is most of the upload wait.
    // Downscale raster formats to a sane max dimension before sending — falls back
    // to the original file untouched on any failure, and skips vector/PDF/HEIC/TIFF
    // (canvas can't safely re-encode those, and print files often need full res).
    async downscaleForUpload(file) {
      const resizable = ['image/png', 'image/jpeg', 'image/webp'];
      if (!resizable.includes(file.type)) return file;
      const MAX_DIM = 2400;
      try {
        const bitmap = await createImageBitmap(file);
        const longest = Math.max(bitmap.width, bitmap.height);
        if (longest <= MAX_DIM && file.size <= 4 * 1024 * 1024) {
          if (bitmap.close) bitmap.close();
          return file;
        }
        const scale = Math.min(1, MAX_DIM / longest);
        const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
        if (bitmap.close) bitmap.close();
        const quality = file.type === 'image/jpeg' ? 0.88 : undefined;
        const blob = await new Promise(r => canvas.toBlob(r, file.type, quality));
        if (!blob || blob.size >= file.size) return file;
        return new File([blob], file.name, { type: file.type });
      } catch (e) {
        return file;
      }
    },
    async uploadArtwork(color, area, file) {
      this.errorMsg = '';
      if (!file) return;
      const okExt = /\.(png|jpe?g|svg|webp|pdf|heic|tiff?)$/i;
      if (!okExt.test(file.name)) return (this.errorMsg = 'Please upload a PNG, SVG, JPG, HEIC, TIFF, WEBP or PDF file.');
      if (file.size > 50 * 1024 * 1024) return (this.errorMsg = 'File is too large (max 50 MB).');
      if (!this.uploadKey) return (this.errorMsg = 'Uploads are not configured yet — please contact us to place this order.');

      const artKey = this.key(color, area);
      this.artwork[artKey] = { url: '', filename: file.name, localUrl: URL.createObjectURL(file), uploading: true };
      // Show the local preview on the canvas immediately — the real Uploadcare
      // upload below can take several seconds, and without this the design only
      // appears once that finishes, which reads as "upload doesn't work".
      this.$dispatch('gpl:artwork-changed', { color, area });
      try {
        const uploadFile = await this.downscaleForUpload(file);
        const fd = new FormData();
        fd.append('UPLOADCARE_PUB_KEY', this.uploadKey);
        fd.append('UPLOADCARE_STORE', '1');
        fd.append('file', uploadFile, file.name);
        const res = await fetch('https://upload.uploadcare.com/base/', { method: 'POST', body: fd });
        if (!res.ok) throw new Error('upload failed');
        const data = await res.json();
        this.artwork[artKey] = {
          url: 'https://' + this.cdnBase + '/' + data.file + '/' + encodeURIComponent(file.name),
          filename: file.name,
          localUrl: this.artwork[artKey].localUrl,
          uploading: false,
        };
        this.$dispatch('gpl:artwork-changed', { color, area });
      } catch (e) {
        delete this.artwork[artKey];
        this.errorMsg = 'Artwork upload failed — please try again.';
      }
    },
    removeArtwork(color, area) {
      const artKey = this.key(color, area);
      delete this.artwork[artKey];
      delete this.placement[artKey];
      this.$dispatch('gpl:artwork-changed', { color, area });
    },

    // ---- submit ----
    canSubmit() {
      return this.hasArtwork() && this.totalUnits() > 0 && !this.submitting
        && !Object.values(this.artwork).some(a => a && a.uploading);
    },
    gateMessage() {
      if (!this.openColors.length) return 'Please select at least one colour';
      const missing = this.openColors.filter(c => !this.hasArtworkFor(c));
      if (missing.length) return 'Please upload artwork for ' + missing.join(', ');
      if (this.totalUnits() === 0) return 'Please enter quantities for at least one colour and size';
      return '';
    },
    lineProperties(colorName) {
      const used = this.areas.map(a => a.name).filter(a => {
        const art = this.artwork[this.key(colorName, a)];
        return art && art.url;
      });
      const props = {
        'Print Method': this.methodFor(colorName),
        'Print Areas': used.join(', '),
      };
      if (this.designerNotes && this.designerNotes.trim()) props['Designer Notes'] = this.designerNotes.trim().slice(0, 500);
      used.forEach(a => {
        const artKey = this.key(colorName, a);
        props['Artwork — ' + a] = this.artwork[artKey].url;
        if (this.placement[artKey]) props['_Placement ' + a] = JSON.stringify(this.placement[artKey]);
      });
      return props;
    },
    async uploadBlob(name, blob) {
      const fd = new FormData();
      fd.append('UPLOADCARE_PUB_KEY', this.uploadKey);
      fd.append('UPLOADCARE_STORE', '1');
      fd.append('file', blob, name);
      const res = await fetch('https://upload.uploadcare.com/base/', { method: 'POST', body: fd });
      if (!res.ok) throw new Error('upload failed');
      const data = await res.json();
      return 'https://' + this.cdnBase + '/' + data.file + '/' + encodeURIComponent(name);
    },
    loadImg(src) {
      return new Promise((resolve, reject) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = src;
      });
    },
    async generatePreview(color, area) {
      const artKey = this.key(color, area);
      const art = this.artwork[artKey];
      if (!art || !art.url) return null;
      const a = this.areas.find(x => x.name === area);
      const mock = await this.loadImg(this.mockupFor(color, area));
      const artImg = await this.loadImg(art.url);
      const W = 900, H = Math.round(W * mock.height / mock.width);
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      g.drawImage(mock, 0, 0, W, H);
      const z = { x: a.zone.x * W, y: a.zone.y * H, w: a.zone.w * W, h: a.zone.h * H };
      const p = this.placement[artKey] || { cx: 0.5, cy: 0.5, w: 0.85 };
      const dw = p.w * z.w, dh = dw * artImg.height / artImg.width;
      g.save();
      g.translate(z.x + p.cx * z.w, z.y + p.cy * z.h);
      if (p.angle) g.rotate(p.angle * Math.PI / 180);
      g.drawImage(artImg, -dw / 2, -dh / 2, dw, dh);
      g.restore();
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
      if (!blob) return null;
      return await this.uploadBlob('preview-' + color.toLowerCase().replace(/\s+/g, '-') + '-' + area.toLowerCase().replace(/\s+/g, '-') + '.jpg', blob);
    },
    async addToCart() {
      if (!this.canSubmit()) return;
      this.submitting = true;
      this.errorMsg = '';
      // Each colour now has its own artwork, so previews are generated per colour
      // (not once and shared) and merged into that colour's own line properties.
      const previewsByColor = {};
      try {
        for (const color of this.openColors) {
          const used = this.areas.map(x => x.name).filter(x => {
            const art = this.artwork[this.key(color, x)];
            return art && art.url;
          });
          const props = {};
          for (const area of used) {
            const url = await this.generatePreview(color, area);
            if (url) props['Preview — ' + area] = url;
          }
          previewsByColor[color] = props;
        }
      } catch (e) { /* previews are best-effort */ }
      const items = [];
      for (const k in this.qty) {
        const [color, size] = k.split('|');
        const v = this.resolvedVariant(color, size);
        if (!v) { this.errorMsg = 'Missing variant for ' + color + ' / ' + size; this.submitting = false; return; }
        const props = Object.assign(this.lineProperties(color), previewsByColor[color] || {});
        items.push({ id: v.id, quantity: this.qty[k], properties: props });
      }
      try {
        const res = await fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.description || err.message || 'Could not add to cart');
        }
        this.clearPersist();
        window.location.href = '/cart';
      } catch (e) {
        this.errorMsg = e.message || 'Could not add to cart — please try again.';
        this.submitting = false;
      }
    },

    deliveryRange() {
      const fmt = d => d.toLocaleDateString('en-CA', { month: 'long', day: 'numeric' });
      const a = new Date(); a.setDate(a.getDate() + (config.shipMinDays || 8));
      const b = new Date(); b.setDate(b.getDate() + (config.shipMaxDays || 14));
      return fmt(a) + ' - ' + fmt(b);
    },

    // ---- persistence (survive refresh) ----
    persistKey() { return 'gpl-customizer-' + config.productId; },
    persist() {
      try {
        const art = {};
        for (const a in this.artwork) {
          if (this.artwork[a] && this.artwork[a].url) art[a] = { url: this.artwork[a].url, filename: this.artwork[a].filename };
        }
        localStorage.setItem(this.persistKey(), JSON.stringify({
          qty: this.qty, artwork: art, methodByColor: this.methodByColor, openColors: this.openColors, placement: this.placement, notes: this.designerNotes,
        }));
      } catch (e) { /* private mode */ }
    },
    restore() {
      try {
        const raw = localStorage.getItem(this.persistKey());
        if (!raw) return;
        const s = JSON.parse(raw);
        this.qty = s.qty || {};
        this.artwork = s.artwork || {};
        this.placement = s.placement || {};
        if (s.methodByColor) this.methodByColor = s.methodByColor;
        if (s.notes) this.designerNotes = s.notes;
        if (s.openColors && s.openColors.length) { this.openColors = s.openColors; this.activeColor = s.openColors[0]; }
      } catch (e) { /* ignore */ }
    },
    clearPersist() { try { localStorage.removeItem(this.persistKey()); } catch (e) {} },
  };
};
