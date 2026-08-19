/* GTA Print Lab — quick-order customizer (Alpine component)
   Data contract: see docs/customizer-data-model.md */
window.gplQuickOrder = function (config) {
  const fx = { canvas: null, obj: null, ro: null };   // fabric state kept OUT of Alpine's reactive proxy
  return {
    // ---- config ----
    variants: config.variants,        // [{id, color, size, tier, price, available, image}]
    sizes: config.sizes,              // ordered unique sizes
    colors: config.colors,            // [{name, hex, image}]
    areas: config.areas,              // [{name, zone:{x,y,w,h}}]
    mockups: config.mockups,          // {"Color|Area": url}
    fallbackImage: config.fallbackImage,
    uploadKey: config.uploadKey || '',
    cdnBase: (config.cdnBase || 'ucarecdn.com').replace(/^https?:\/\//,'').replace(/\/$/,''),
    methods: config.methods,          // [{name, description}]

    // ---- state ----
    openColors: [],
    showAddColor: false,
    qty: {},                          // "Color|Size" -> int
    artwork: {},                      // area -> {url, filename, localUrl, uploading}
    placement: {},                    // area -> {x,y,scale,angle} (filled by editor task)
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
      const art = this.artwork[area];
      if (!art || !(art.localUrl || art.url)) { fx.canvas.requestRenderAll(); return; }
      const src = art.localUrl || art.url;
      fabric.Image.fromURL(src, (img) => {
        if (!img || this.activePrintArea !== area) return;
        const z = this.zonePx(area);
        if (!z) return;
        const p = this.placement[area];
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
      this.placement[this.activePrintArea] = {
        cx: (fx.obj.left - z.x) / z.w,
        cy: (fx.obj.top - z.y) / z.h,
        w: (fx.obj.getScaledWidth()) / z.w,
        angle: Math.round(fx.obj.angle || 0),
      };
      this.persist();
    },

    // Match product image filenames to colors: "1200W-625-Royal-12-...FlatFront3.jpg",
    // "sport_grey_fornt.jpg" etc. Alt "Front"/"Back" picks the area; explicit
    // "mockup:Color:Area" alts (this.mockups) always win.
    buildMockupMap(images) {
      const alias = {
        'gold': ['oldgold'], 'safety orange': ['sorange'], 'forest green': ['forestgrn'],
        'graphite heather': ['gphheather'], 'carolina blue': ['carolinabl'],
        'irish green': ['irishgreen'], 'light blue': ['lightblue', 'sky'],
        'sport grey': ['sportgrey', 'sport_grey'], 'dark heather': ['darkheather', 'dark_heather'],
        'cardinal red': ['cardinalrd'], 'texas orange': ['txorange', 'texasorange'],
        'yellow haze': ['yellowhaze'], 'dark chocolate': ['darkchocolate', 'dkchocolate'],
        'military green': ['militarygrn', 'militarygreen'], 'heliconia': ['heliconia'],
      };
      const norm = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');
      for (const img of images) {
        // Shopify's Liquid `image.alt` silently falls back to the product title when
        // no alt text is set on the image — it's never actually blank. Only accept
        // images explicitly tagged exactly "Front"/"Back" as clean per-colour photos,
        // so an untagged lifestyle shot (alt == product title) can never win a
        // colour|view slot over the real photo (e.g. "YOUR DESIGN HERE" baked into a
        // hero shot's pixels beating out the genuine blank "black_front" photo).
        const altRaw = (img.alt || '').trim();
        if (!/^(front|back)$/i.test(altRaw)) continue;
        const fname = norm((img.src.split('/').pop() || '').split('?')[0]);
        const view = /^back$/i.test(altRaw) ? 'Back' : 'Front';
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
    areasUsed() { return Object.keys(this.artwork).filter(a => this.artwork[a] && this.artwork[a].url).length; },
    findVariant(color, size, tier) {
      return this.variants.find(v => v.color === color && v.size === size && v.tier === tier);
    },
    resolvedVariant(color, size) {
      const tier = this.tierName(Math.max(1, this.areasUsed()));
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
    colorHex: {
      'black': '#1A1A1A', 'white': '#FFFFFF', 'ash': '#E5E4DF', 'charcoal': '#4A4A4A',
      'sport grey': '#9EA0A3', 'navy': '#1D2545', 'natural': '#EFE8D8', 'dark heather': '#5B5A5F',
      'red': '#C8102E', 'royal': '#1F4E9C', 'maroon': '#5B2B38', 'purple': '#3E2B56',
      'forest green': '#1E3B2C', 'irish green': '#00A65E', 'military green': '#5A5B45',
      'light pink': '#F4C3CE', 'light blue': '#A3C6E8', 'sand': '#D6CCB2', 'daisy': '#F7C63F',
      'gold': '#F2A93B', 'orange': '#F26322', 'cardinal red': '#8A1538', 'heliconia': '#E24585',
      'sapphire': '#0077B5', 'carolina blue': '#7BA4DB', 'dark chocolate': '#3B2B24',
      'garnet': '#6E2639', 'kelly green': '#00805E', 'texas orange': '#B4552D', 'cherry red': '#AC2B37',
      'safety orange': '#FF6D00', 'graphite heather': '#707372', 'violet': '#8D6CAB',
      'yellow haze': '#F5E1A4', 'azalea': '#F65275', 'midnight': '#1F2A44',
    },
    // resolve a colour to a hex for SVG clip art / swatches
    hexFor(name) {
      const c = this.swatch(name) || {};
      if (c.hex) return c.hex;
      return this.colorHex[(name || '').toLowerCase()] || '#C4C4C4';
    },
    // which clip-art shape a print area uses
    artShape(areaName) {
      const n = (areaName || '').toLowerCase();
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
      return 'M32 14 L18 20 L8 36 L19 44 L26 36 L26 88 L74 88 L74 36 L81 44 L92 36 L82 20 L68 14 C63 23 37 23 32 14 Z';
    },
    collarPath(areaName) {
      const s = this.artShape(areaName);
      if (s === 'front') return 'M32 14 C37 23 63 23 68 14';
      if (s === 'back') return 'M33 15 C38 20 62 20 67 15';
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
      const hex = this.colorHex[(name || '').toLowerCase()];
      if (hex) return 'background-color:' + hex;
      return 'background-color:#C4C4C4';
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
      Object.keys(this.qty).forEach(k => { if (k.startsWith(name + '|')) delete this.qty[k]; });
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
    hasArtwork() { return this.areasUsed() > 0; },
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
    async uploadArtwork(area, file) {
      this.errorMsg = '';
      if (!file) return;
      const okExt = /\.(png|jpe?g|svg|webp|pdf|heic|tiff?)$/i;
      if (!okExt.test(file.name)) return (this.errorMsg = 'Please upload a PNG, SVG, JPG, HEIC, TIFF, WEBP or PDF file.');
      if (file.size > 50 * 1024 * 1024) return (this.errorMsg = 'File is too large (max 50 MB).');
      if (!this.uploadKey) return (this.errorMsg = 'Uploads are not configured yet — please contact us to place this order.');

      this.artwork[area] = { url: '', filename: file.name, localUrl: URL.createObjectURL(file), uploading: true };
      try {
        const uploadFile = await this.downscaleForUpload(file);
        const fd = new FormData();
        fd.append('UPLOADCARE_PUB_KEY', this.uploadKey);
        fd.append('UPLOADCARE_STORE', '1');
        fd.append('file', uploadFile, file.name);
        const res = await fetch('https://upload.uploadcare.com/base/', { method: 'POST', body: fd });
        if (!res.ok) throw new Error('upload failed');
        const data = await res.json();
        this.artwork[area] = {
          url: 'https://' + this.cdnBase + '/' + data.file + '/' + encodeURIComponent(file.name),
          filename: file.name,
          localUrl: this.artwork[area].localUrl,
          uploading: false,
        };
        this.$dispatch('gpl:artwork-changed', { area });
      } catch (e) {
        delete this.artwork[area];
        this.errorMsg = 'Artwork upload failed — please try again.';
      }
    },
    removeArtwork(area) {
      delete this.artwork[area];
      delete this.placement[area];
      this.$dispatch('gpl:artwork-changed', { area });
    },

    // ---- submit ----
    canSubmit() {
      return this.hasArtwork() && this.totalUnits() > 0 && !this.submitting
        && !Object.values(this.artwork).some(a => a && a.uploading);
    },
    gateMessage() {
      if (!this.hasArtwork()) return 'Please upload your artwork to start customizing your product';
      if (this.totalUnits() === 0) return 'Please enter quantities for at least one colour and size';
      return '';
    },
    lineProperties(colorName) {
      const used = this.areas.map(a => a.name).filter(a => this.artwork[a] && this.artwork[a].url);
      const props = {
        'Print Method': this.methodFor(colorName),
        'Print Areas': used.join(', '),
      };
      if (this.designerNotes && this.designerNotes.trim()) props['Designer Notes'] = this.designerNotes.trim().slice(0, 500);
      used.forEach(a => {
        props['Artwork — ' + a] = this.artwork[a].url;
        if (this.placement[a]) props['_Placement ' + a] = JSON.stringify(this.placement[a]);
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
    async generatePreview(area) {
      const art = this.artwork[area];
      if (!art || !art.url) return null;
      const a = this.areas.find(x => x.name === area);
      const mock = await this.loadImg(this.mockupFor(this.activeColor, area));
      const artImg = await this.loadImg(art.url);
      const W = 900, H = Math.round(W * mock.height / mock.width);
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      g.drawImage(mock, 0, 0, W, H);
      const z = { x: a.zone.x * W, y: a.zone.y * H, w: a.zone.w * W, h: a.zone.h * H };
      const p = this.placement[area] || { cx: 0.5, cy: 0.5, w: 0.85 };
      const dw = p.w * z.w, dh = dw * artImg.height / artImg.width;
      g.save();
      g.translate(z.x + p.cx * z.w, z.y + p.cy * z.h);
      if (p.angle) g.rotate(p.angle * Math.PI / 180);
      g.drawImage(artImg, -dw / 2, -dh / 2, dw, dh);
      g.restore();
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
      if (!blob) return null;
      return await this.uploadBlob('preview-' + area.toLowerCase().replace(/\s+/g, '-') + '.jpg', blob);
    },
    async addToCart() {
      if (!this.canSubmit()) return;
      this.submitting = true;
      this.errorMsg = '';
      // Artwork/placement/notes are shared across every colour in the order — only
      // the printing technique varies per colour — so previews are generated once
      // and merged into each colour's own line properties below.
      const previewProps = {};
      try {
        const used = this.areas.map(x => x.name).filter(x => this.artwork[x] && this.artwork[x].url);
        for (const area of used) {
          const url = await this.generatePreview(area);
          if (url) previewProps['Preview — ' + area] = url;
        }
      } catch (e) { /* previews are best-effort */ }
      const items = [];
      for (const k in this.qty) {
        const [color, size] = k.split('|');
        const v = this.resolvedVariant(color, size);
        if (!v) { this.errorMsg = 'Missing variant for ' + color + ' / ' + size; this.submitting = false; return; }
        const props = Object.assign(this.lineProperties(color), previewProps);
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
