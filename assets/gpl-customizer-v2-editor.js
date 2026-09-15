/* GTA Print Lab — customizer v2 editor mixin.
   Merged over the base Alpine component (gpl-customizer-v2.js) and overrides the
   single-image Fabric editor with a multi-object design editor: uploaded images,
   text and numbers, all per (colour | print area).

   Design storage is resolution-independent: every object's position and size is
   stored in "zone units" where the print zone is 1000 units wide, so the same
   design renders on the 900px preview, on the phone-sized stage, and at 300 DPI
   on a print server (Phase 2) by changing one scale factor. */
(function () {
  const ZU = 1000;                       // zone width in design units
  const STORE = new WeakMap();           // fabric state kept OUT of Alpine's reactive proxy
  const PROOF_DPI = 150;                 // client-side proof; real 300 DPI render is Phase 2

  const FONTS = [
    { name: 'Anton', weight: '400' },
    { name: 'Bebas Neue', weight: '400' },
    { name: 'Oswald', weight: '700' },
    { name: 'Archivo Black', weight: '400' },
    { name: 'Black Ops One', weight: '400' },
    { name: 'Bangers', weight: '400' },
    { name: 'Montserrat', weight: '800' },
    { name: 'Roboto Condensed', weight: '700' },
    { name: 'Permanent Marker', weight: '400' },
    { name: 'Pacifico', weight: '400' },
  ];

  const uid = () => 'o' + Math.random().toString(36).slice(2, 9);
  const clone = (o) => JSON.parse(JSON.stringify(o));

  window.gplEditorMixin = {
    // ---- extra state ----
    designs: {},                          // "Color|Area" -> { objects: [...] } in zone units
    fonts: FONTS,
    sel: { has: false, id: '', type: '', text: '', fontFamily: 'Anton', fontSize: 140, fill: '#FFFFFF',
           stroke: '#000000', strokeWidth: 0, fontWeight: '400', charSpacing: 0 },
    tool: 'select',

    // ---- fabric state ----
    fx() {
      let s = STORE.get(this.$root);
      if (!s) { s = { canvas: null, ro: null, loading: false }; STORE.set(this.$root, s); }
      return s;
    },
    zoneFactor(areaName) {
      const z = this.zonePx(areaName || this.activePrintArea);
      return z ? z.w / ZU : 1;
    },
    designKey(color, area) { return (color || this.activeColor) + '|' + (area || this.activePrintArea); },
    designFor(color, area) { return this.designs[this.designKey(color, area)] || { objects: [] }; },
    designHasObjects(color, area) { return this.designFor(color, area).objects.length > 0; },

    // ---- editor bootstrap (overrides base) ----
    initFabric() {
      if (!window.fabric) return;
      const el = this.$refs.fcanvas;
      const stage = this.stageEl();
      if (!el || !stage) return;
      const fx = this.fx();
      fabric.Object.prototype.set({
        cornerColor: '#D71920', cornerStrokeColor: '#FFFFFF', borderColor: '#D71920',
        cornerSize: 11, transparentCorners: false, lockScalingFlip: true,
      });
      fx.canvas = new fabric.Canvas(el, { selection: true, preserveObjectStacking: true });
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
        if (!z || !o) return;
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
      fx.canvas.on('object:rotating', e => clamp(e.target));
      fx.canvas.on('object:modified', e => { clamp(e.target); this.saveDesign(); fx.canvas.requestRenderAll(); });
      fx.canvas.on('selection:created', () => this.syncSel());
      fx.canvas.on('selection:updated', () => this.syncSel());
      fx.canvas.on('selection:cleared', () => this.syncSel());
      fx.canvas.on('text:changed', () => { this.syncSel(); this.saveDesign(); });
      // keyboard: delete removes selection unless typing in a field
      this._onKey = (ev) => {
        if ((ev.key === 'Delete' || ev.key === 'Backspace') && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)
            && fx.canvas.getActiveObject() && !fx.canvas.getActiveObject().isEditing) {
          ev.preventDefault(); this.deleteSelected();
        }
      };
      document.addEventListener('keydown', this._onKey);
      this.loadAreaIntoFabric();
    },

    // ---- (de)serialisation in zone units ----
    serializeObject(o) {
      const z = this.zonePx(this.activePrintArea);
      const f = z.w / ZU;
      const base = {
        id: o._gplId || (o._gplId = uid()),
        type: o.type === 'image' ? 'image' : 'text',
        cx: +((o.left - z.x) / f).toFixed(2),
        cy: +((o.top - z.y) / f).toFixed(2),
        angle: Math.round(o.angle || 0),
      };
      if (base.type === 'image') {
        base.src = o._gplSrc || (o.getSrc && o.getSrc()) || '';
        base.filename = o._gplFilename || '';
        base.w = +(o.getScaledWidth() / f).toFixed(2);
      } else {
        // fold any corner-scaling into the font size so text stays crisp
        base.text = o.text;
        base.fontFamily = o.fontFamily;
        base.fontWeight = String(o.fontWeight || '400');
        base.fontSize = +((o.fontSize * (o.scaleY || 1)) / f).toFixed(2);
        base.fill = o.fill;
        base.stroke = o.stroke || '';
        base.strokeWidth = +(((o.strokeWidth || 0) * (o.scaleY || 1)) / f).toFixed(2);
        base.charSpacing = o.charSpacing || 0;
        base.textAlign = o.textAlign || 'center';
      }
      return base;
    },
    saveDesign() {
      const fx = this.fx();
      if (!fx.canvas || fx.loading) return;
      // dedupe by id: guards against any object that got onto the canvas twice
      const seen = new Set();
      const objs = fx.canvas.getObjects().map(o => this.serializeObject(o)).filter(d => !seen.has(d.id) && seen.add(d.id));
      const key = this.designKey();
      if (objs.length) this.designs[key] = { objects: objs };
      else delete this.designs[key];
      this.persist();
    },
    // build a fabric object from a stored one, at a given zone rect (px)
    enliven(d, z) {
      const f = z.w / ZU;
      const common = {
        left: z.x + d.cx * f, top: z.y + d.cy * f, angle: d.angle || 0,
        originX: 'center', originY: 'center',
      };
      return new Promise((resolve) => {
        if (d.type === 'image') {
          fabric.Image.fromURL(d.src, (img) => {
            if (!img) return resolve(null);
            img.set(common);
            img.scaleToWidth(Math.max(1, d.w * f));
            img._gplId = d.id; img._gplSrc = d.src; img._gplFilename = d.filename || '';
            img.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
            resolve(img);
          }, { crossOrigin: 'anonymous' });
        } else {
          const t = new fabric.Text(d.text || '', Object.assign(common, {
            fontFamily: d.fontFamily || 'Anton',
            fontWeight: d.fontWeight || '400',
            fontSize: Math.max(4, (d.fontSize || 140) * f),
            fill: d.fill || '#FFFFFF',
            stroke: d.stroke || '',
            strokeWidth: (d.strokeWidth || 0) * f,
            paintFirst: 'stroke',
            charSpacing: d.charSpacing || 0,
            textAlign: d.textAlign || 'center',
          }));
          t._gplId = d.id;
          t.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
          resolve(t);
        }
      });
    },
    async loadAreaIntoFabric() {
      const fx = this.fx();
      if (!fx.canvas) return;
      const area = this.activePrintArea, color = this.activeColor;
      const z = this.zonePx(area);
      if (!z) { fx.canvas.clear(); return; }
      // Loads overlap constantly (font swaps and image loads resize the stage, and
      // the ResizeObserver reloads on every resize). Only the newest load may touch
      // the canvas, and it clears + repopulates in one synchronous step after its
      // images have arrived — so two in-flight loads can never both add the same
      // design (which is what produced duplicate objects).
      const seq = (fx.loadSeq = (fx.loadSeq || 0) + 1);
      fx.loading = true;
      const design = this.designFor(color, area);
      const objs = await Promise.all(design.objects.map(d => this.enliven(d, z)));
      if (seq !== fx.loadSeq) return;                                    // superseded
      if (this.activePrintArea !== area || this.activeColor !== color) { fx.loading = false; return; }
      fx.canvas.clear();
      objs.filter(Boolean).forEach(o => fx.canvas.add(o));
      fx.canvas.discardActiveObject();
      fx.canvas.requestRenderAll();
      fx.loading = false;
      this.syncSel();
    },
    savePlacement() { this.saveDesign(); },   // base name, kept for safety

    // ---- selection <-> panel ----
    syncSel() {
      const fx = this.fx();
      const o = fx.canvas && fx.canvas.getActiveObject();
      if (!o || o.type === 'activeSelection') { this.sel.has = false; this.sel.id = ''; this.sel.type = ''; return; }
      const f = this.zoneFactor();
      this.sel.has = true;
      this.sel.id = o._gplId || '';
      this.sel.type = o.type === 'image' ? 'image' : 'text';
      if (this.sel.type === 'text') {
        this.sel.text = o.text;
        this.sel.fontFamily = o.fontFamily;
        this.sel.fontWeight = String(o.fontWeight || '400');
        this.sel.fontSize = Math.round((o.fontSize * (o.scaleY || 1)) / f);
        this.sel.fill = o.fill;
        this.sel.stroke = o.stroke || '#000000';
        this.sel.strokeWidth = Math.round(((o.strokeWidth || 0) * (o.scaleY || 1)) / f);
        this.sel.charSpacing = o.charSpacing || 0;
      }
    },
    async applySel() {
      const fx = this.fx();
      const o = fx.canvas && fx.canvas.getActiveObject();
      if (!o || this.sel.type !== 'text') return;
      const f = this.zoneFactor();
      await this.ensureFont(this.sel.fontFamily, this.sel.fontWeight);
      // un-fold scale so size edits are absolute
      o.set({
        text: this.sel.text,
        fontFamily: this.sel.fontFamily,
        fontWeight: this.sel.fontWeight,
        fontSize: Math.max(4, this.sel.fontSize * f),
        scaleX: 1, scaleY: 1,
        fill: this.sel.fill,
        stroke: this.sel.strokeWidth > 0 ? this.sel.stroke : '',
        strokeWidth: this.sel.strokeWidth * f,
        paintFirst: 'stroke',
        charSpacing: Number(this.sel.charSpacing) || 0,
      });
      o.setCoords();
      fx.canvas.requestRenderAll();
      this.saveDesign();
    },
    ensureFont(family, weight) {
      try { return document.fonts.load((weight || '400') + ' 40px "' + family + '"'); } catch (e) { return Promise.resolve(); }
    },

    // ---- tools ----
    async addText(preset) {
      const fx = this.fx();
      const z = this.zonePx(this.activePrintArea);
      if (!fx.canvas || !z) return;
      const f = z.w / ZU;
      const p = Object.assign({
        text: 'YOUR TEXT', fontFamily: 'Anton', fontWeight: '400', fontSize: 140,
        fill: this.isLight(this.activeColor) ? '#111111' : '#FFFFFF', stroke: '', strokeWidth: 0, charSpacing: 0,
      }, preset || {});
      await this.ensureFont(p.fontFamily, p.fontWeight);
      const t = await this.enliven(Object.assign({ id: uid(), type: 'text', cx: ZU / 2, cy: (z.h / f) / 2, angle: 0 }, p), z);
      fx.canvas.add(t);
      fx.canvas.setActiveObject(t);
      fx.canvas.requestRenderAll();
      this.saveDesign();
      this.syncSel();
    },
    addNumber() {
      const dark = this.isLight(this.activeColor);
      return this.addText({
        text: '00', fontFamily: 'Anton', fontSize: 420,
        fill: dark ? '#111111' : '#FFFFFF', stroke: dark ? '#FFFFFF' : '#111111', strokeWidth: 14, charSpacing: 20,
      });
    },
    async addImageFromUrl(url, filename) {
      const fx = this.fx();
      const z = this.zonePx(this.activePrintArea);
      if (!fx.canvas || !z) return;
      const f = z.w / ZU;
      const probe = await this.loadImg(url).catch(() => null);
      if (!probe) return;
      // fit inside 85% of the zone by default
      const maxW = ZU * 0.85, maxH = (z.h / f) * 0.85;
      const s = Math.min(maxW / probe.width, maxH / probe.height);
      const w = probe.width * s;
      const o = await this.enliven({ id: uid(), type: 'image', src: url, filename: filename || '', cx: ZU / 2, cy: (z.h / f) / 2, w, angle: 0 }, z);
      if (!o) return;
      fx.canvas.add(o);
      fx.canvas.setActiveObject(o);
      fx.canvas.requestRenderAll();
      this.saveDesign();
      this.syncSel();
    },
    deleteSelected() {
      const fx = this.fx();
      const o = fx.canvas && fx.canvas.getActiveObject();
      if (!o) return;
      if (o.type === 'activeSelection') o.forEachObject(x => fx.canvas.remove(x));
      else fx.canvas.remove(o);
      fx.canvas.discardActiveObject();
      fx.canvas.requestRenderAll();
      this.saveDesign();
      this.syncSel();
    },
    duplicateSelected() {
      const fx = this.fx();
      const o = fx.canvas && fx.canvas.getActiveObject();
      if (!o || o.type === 'activeSelection') return;
      const d = this.serializeObject(o);
      d.id = uid(); d.cx += 40; d.cy += 40;
      this.enliven(d, this.zonePx(this.activePrintArea)).then(n => {
        if (!n) return;
        fx.canvas.add(n); fx.canvas.setActiveObject(n); fx.canvas.requestRenderAll();
        this.saveDesign(); this.syncSel();
      });
    },
    bringForward() { const fx = this.fx(); const o = fx.canvas && fx.canvas.getActiveObject(); if (o) { fx.canvas.bringForward(o); fx.canvas.requestRenderAll(); this.saveDesign(); } },
    sendBackward() { const fx = this.fx(); const o = fx.canvas && fx.canvas.getActiveObject(); if (o) { fx.canvas.sendBackwards(o); fx.canvas.requestRenderAll(); this.saveDesign(); } },
    centerSelected() {
      const fx = this.fx(); const o = fx.canvas && fx.canvas.getActiveObject(); const z = this.zonePx(this.activePrintArea);
      if (!o || !z) return;
      o.set({ left: z.x + z.w / 2, top: z.y + z.h / 2 }); o.setCoords(); fx.canvas.requestRenderAll(); this.saveDesign();
    },
    clearArea(color, area) {
      delete this.designs[this.designKey(color, area)];
      delete this.artwork[this.key(color, area)];
      this.persist();
      if ((color || this.activeColor) === this.activeColor && (area || this.activePrintArea) === this.activePrintArea) this.loadAreaIntoFabric();
    },
    objectsInArea() { return this.designFor().objects; },
    selectById(id) {
      const fx = this.fx();
      const o = fx.canvas && fx.canvas.getObjects().find(x => x._gplId === id);
      if (o) { fx.canvas.setActiveObject(o); fx.canvas.requestRenderAll(); this.syncSel(); }
    },

    // ---- uploads: originals are kept at full resolution (no downscale) ----
    async uploadArtwork(color, area, file) {
      this.errorMsg = '';
      if (!file) return;
      const okExt = /\.(png|jpe?g|svg|webp|pdf|heic|tiff?)$/i;
      if (!okExt.test(file.name)) return (this.errorMsg = 'Please upload a PNG, SVG, JPG, HEIC, TIFF, WEBP or PDF file.');
      if (file.size > 50 * 1024 * 1024) return (this.errorMsg = 'File is too large (max 50 MB).');
      if (!this.uploadKey) return (this.errorMsg = 'Uploads are not configured yet — please contact us to place this order.');
      const artKey = this.key(color, area);
      this.uploadingCount = (this.uploadingCount || 0) + 1;
      try {
        const url = await this.uploadBlob(file.name, file);
        const list = (this.artwork[artKey] && Array.isArray(this.artwork[artKey])) ? this.artwork[artKey] : [];
        list.push({ url, filename: file.name });
        this.artwork[artKey] = list;
        // canvas can't paint PDF/HEIC/TIFF; Uploadcare can convert them for the preview
        const previewUrl = /\.(pdf|heic|tiff?)$/i.test(file.name) ? url.replace(/\/[^/]*$/, '/-/format/png/-/preview/2000x2000/') : url;
        if (color === this.activeColor && area === this.activePrintArea) await this.addImageFromUrl(previewUrl, file.name);
        else {
          const d = this.designFor(color, area);
          d.objects.push({ id: uid(), type: 'image', src: previewUrl, filename: file.name, cx: ZU / 2, cy: ZU * 0.6, w: ZU * 0.8, angle: 0 });
          this.designs[this.designKey(color, area)] = d;
          this.persist();
        }
      } catch (e) {
        this.errorMsg = 'Artwork upload failed — please try again.';
      } finally {
        this.uploadingCount = Math.max(0, (this.uploadingCount || 1) - 1);
      }
    },
    removeArtwork(color, area) { this.clearArea(color, area); },

    // ---- coverage / gating ----
    areasUsedFor(color) {
      return this.areas.filter(a => this.designHasObjects(color, a.name)).length;
    },
    hasArtworkFor(color) { return this.areasUsedFor(color) > 0; },
    canSubmit() {
      return this.hasArtwork() && this.totalUnits() > 0 && !this.submitting && !(this.uploadingCount > 0);
    },
    gateMessage() {
      if (!this.openColors.length) return 'Please select at least one colour';
      const missing = this.openColors.filter(c => !this.hasArtworkFor(c));
      if (missing.length) return 'Please add a design for ' + missing.join(', ');
      if (this.totalUnits() === 0) return 'Please enter quantities for at least one colour and size';
      return '';
    },

    // ---- order data ----
    lineProperties(colorName) {
      const used = this.areas.map(a => a.name).filter(a => this.designHasObjects(colorName, a));
      const props = {
        'Print Method': this.methodFor(colorName),
        'Print Areas': used.join(', '),
      };
      if (this.designerNotes && this.designerNotes.trim()) props['Designer Notes'] = this.designerNotes.trim().slice(0, 500);
      used.forEach(a => {
        const d = this.designFor(colorName, a);
        const imgs = d.objects.filter(o => o.type === 'image').map(o => o.src);
        const texts = d.objects.filter(o => o.type === 'text').map(o => o.text);
        if (imgs.length) props['Artwork — ' + a] = imgs.join(' , ');
        if (texts.length) props['Text — ' + a] = texts.join(' | ').slice(0, 500);
      });
      return props;
    },
    // Render a (colour, area) design onto a static canvas at an arbitrary zone size.
    async renderDesign(color, area, zonePxRect, canvasW, canvasH, background) {
      const sc = new fabric.StaticCanvas(null, { width: canvasW, height: canvasH });
      if (background) {
        await new Promise(res => sc.setBackgroundImage(background, res, { scaleX: canvasW / background.width, scaleY: canvasH / background.height }));
      }
      const design = this.designFor(color, area);
      const objs = await Promise.all(design.objects.map(d => this.enliven(d, zonePxRect)));
      objs.filter(Boolean).forEach(o => sc.add(o));
      sc.renderAll();
      const dataUrl = sc.toDataURL({ format: background ? 'jpeg' : 'png', quality: 0.9 });
      sc.dispose();
      return await (await fetch(dataUrl)).blob();
    },
    async generatePreview(color, area) {
      if (!this.designHasObjects(color, area)) return null;
      const a = this.areas.find(x => x.name === area);
      const mock = await this.loadImg(this.mockupFor(color, area));
      const W = 900, H = Math.round(W * mock.height / mock.width);
      const z = { x: a.zone.x * W, y: a.zone.y * H, w: a.zone.w * W, h: a.zone.h * H };
      const blob = await this.renderDesign(color, area, z, W, H, mock);
      const slug = s => s.toLowerCase().replace(/\s+/g, '-');
      return await this.uploadBlob('preview-' + slug(color) + '-' + slug(area) + '.jpg', blob);
    },
    // Transparent proof of the print area alone at PROOF_DPI (Phase 2 replaces with 300 DPI server render)
    async generateProof(color, area) {
      if (!this.designHasObjects(color, area)) return null;
      const a = this.areas.find(x => x.name === area);
      const stageZ = this.zonePx(area);
      const wIn = a.w_in || 12;
      const hIn = a.h_in || (stageZ ? wIn * (stageZ.h / stageZ.w) : 16);
      const W = Math.round(wIn * PROOF_DPI), H = Math.round(hIn * PROOF_DPI);
      const blob = await this.renderDesign(color, area, { x: 0, y: 0, w: W, h: H }, W, H, null);
      const slug = s => s.toLowerCase().replace(/\s+/g, '-');
      return await this.uploadBlob('proof-' + slug(color) + '-' + slug(area) + '-' + PROOF_DPI + 'dpi.png', blob);
    },
    async uploadDesignJson(color, area) {
      const a = this.areas.find(x => x.name === area);
      const payload = { version: 2, units: ZU, area: a, design: this.designFor(color, area) };
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const slug = s => s.toLowerCase().replace(/\s+/g, '-');
      return await this.uploadBlob('design-' + slug(color) + '-' + slug(area) + '.json', blob);
    },
    async addToCart() {
      if (!this.canSubmit()) return;
      this.submitting = true;
      this.errorMsg = '';
      const extraByColor = {};
      try {
        for (const color of this.openColors) {
          const props = {};
          for (const a of this.areas) {
            if (!this.designHasObjects(color, a.name)) continue;
            const [pv, pf, dj] = await Promise.all([
              this.generatePreview(color, a.name).catch(() => null),
              this.generateProof(color, a.name).catch(() => null),
              this.uploadDesignJson(color, a.name).catch(() => null),
            ]);
            if (pv) props['Preview — ' + a.name] = pv;
            if (pf) props['Proof — ' + a.name] = pf;
            if (dj) props['_Design ' + a.name] = dj;
          }
          extraByColor[color] = props;
        }
      } catch (e) { /* best effort */ }
      const items = [];
      for (const k in this.qty) {
        const [color, size] = k.split('|');
        const v = this.resolvedVariant(color, size);
        if (!v) { this.errorMsg = 'Missing variant for ' + color + ' / ' + size; this.submitting = false; return; }
        items.push({ id: v.id, quantity: this.qty[k], properties: Object.assign(this.lineProperties(color), extraByColor[color] || {}) });
      }
      try {
        const res = await fetch('/cart/add.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.description || err.message || 'Could not add to cart'); }
        this.clearPersist();
        window.location.href = '/cart';
      } catch (e) {
        this.errorMsg = e.message || 'Could not add to cart — please try again.';
        this.submitting = false;
      }
    },

    // removing a colour must drop its designs too (the base only knew about artwork/placement)
    removeColor(name) {
      this.openColors = this.openColors.filter(c => c !== name);
      const prefix = name + '|';
      [this.qty, this.artwork, this.designs].forEach(map => {
        Object.keys(map).forEach(k => { if (k.startsWith(prefix)) delete map[k]; });
      });
      delete this.methodByColor[name];
      if (this.activeColor === name) this.activeColor = this.openColors[0] || '';
      this.persist();
      this.loadAreaIntoFabric();
    },

    // ---- persistence ----
    persist() {
      try {
        localStorage.setItem(this.persistKey(), JSON.stringify({
          v: 2, qty: this.qty, designs: this.designs, artwork: this.artwork,
          methodByColor: this.methodByColor, openColors: this.openColors, notes: this.designerNotes,
        }));
      } catch (e) { /* private mode */ }
    },
    restore() {
      try {
        const raw = localStorage.getItem(this.persistKey());
        if (!raw) return;
        const s = JSON.parse(raw);
        if (s.v !== 2) return;                      // never read v1 state into v2
        this.qty = s.qty || {};
        this.designs = s.designs || {};
        this.artwork = s.artwork || {};
        if (s.methodByColor) this.methodByColor = s.methodByColor;
        if (s.notes) this.designerNotes = s.notes;
        if (s.openColors && s.openColors.length) { this.openColors = s.openColors; this.activeColor = s.openColors[0]; }
      } catch (e) { /* ignore */ }
    },
  };
})();
