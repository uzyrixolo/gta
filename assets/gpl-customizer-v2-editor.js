/* GTA Print Lab — customizer v2 editor mixin (Printeez-style workspace).
   Merged over the base Alpine component (gpl-customizer-v2.js) and replaces the
   single-image Fabric editor with a multi-object design editor: uploaded images,
   text and numbers, all per (colour | print area), with smart placements,
   inch-accurate transforms, text styling + warp, undo/redo, layers and an
   artwork library.

   Design storage is resolution-independent: every object's position and size is
   stored in "zone units" where the print zone is 1000 units wide, so the same
   design renders on the stage at any zoom, on the 900px preview, and at 300 DPI
   on a print server (Phase 2) by changing one scale factor. */
(function () {
  const ZU = 1000;                       // zone width in design units
  const STORE = new WeakMap();           // fabric state kept OUT of Alpine's reactive proxy
  const PROOF_DPI = 150;                 // client-side proof; real 300 DPI render is Phase 2
  const PROOF_UNCAL_W = 1800;            // proof width (px) when the print area has no real-world size
  const HISTORY_MAX = 40;
  const LIB_KEY = 'gpl-customizer-v2-library';
  const ZOOMS = [1, 1.25, 1.5, 2, 2.5, 3];

  // Google Fonts loaded by the section; weights/italic describe what each family ships.
  const FONTS = [
    { name: 'Anton', group: 'Sport & display', weights: ['400'] },
    { name: 'Bebas Neue', group: 'Sport & display', weights: ['400'] },
    { name: 'Oswald', group: 'Sport & display', weights: ['400', '700'] },
    { name: 'Teko', group: 'Sport & display', weights: ['700'] },
    { name: 'Russo One', group: 'Sport & display', weights: ['400'] },
    { name: 'Archivo Black', group: 'Sport & display', weights: ['400'] },
    { name: 'Black Ops One', group: 'Sport & display', weights: ['400'] },
    { name: 'Bangers', group: 'Sport & display', weights: ['400'] },
    { name: 'Montserrat', group: 'Business', weights: ['400', '700', '800'], italic: true },
    { name: 'Roboto Condensed', group: 'Business', weights: ['400', '700'], italic: true },
    { name: 'Open Sans', group: 'Business', weights: ['400', '700'], italic: true },
    { name: 'Inter', group: 'Business', weights: ['400', '700'] },
    { name: 'Playfair Display', group: 'Serif', weights: ['400', '700'], italic: true },
    { name: 'Merriweather', group: 'Serif', weights: ['400', '700'], italic: true },
    { name: 'Permanent Marker', group: 'Script & handwritten', weights: ['400'] },
    { name: 'Pacifico', group: 'Script & handwritten', weights: ['400'] },
    { name: 'Lobster', group: 'Script & handwritten', weights: ['400'] },
    { name: 'Dancing Script', group: 'Script & handwritten', weights: ['700'] },
  ];

  // Smart placements (inches, relative to the print area). Only offered on areas
  // at least 8in wide (chest/back), never on sleeves or cap panels.
  // Smart placements. `w`/`top` are inches and are used only on a garment whose print
  // area is calibrated (the zone carries a real w_in). Everywhere else the same
  // placement is applied as `wf`/`topf` — a fraction of the print area — so the tool
  // still works without inventing a measurement we have not actually measured.
  const PLACEMENTS = [
    { id: 'free', name: 'Free form', desc: 'Place anywhere', descf: 'Place anywhere' },
    { id: 'standard', name: 'Standard', desc: '10 in wide · 2 in down', descf: 'Large · high on the chest', w: 10, top: 2, wf: 0.83, topf: 0.125, x: 'center' },
    { id: 'left_chest', name: 'Left chest', desc: '4 in wide · pocket side', descf: 'Small · pocket side', w: 4, top: 1.5, wf: 0.33, topf: 0.09, x: 'left_chest' },
    { id: 'pocket', name: 'Pocket', desc: '3.5 in · on the pocket', descf: 'Small · on the pocket', w: 3.5, top: 3, wf: 0.29, topf: 0.19, x: 'left_chest' },
    { id: 'center_chest', name: 'Center chest', desc: '7 in wide · 3 in down', descf: 'Medium · centred', w: 7, top: 3, wf: 0.58, topf: 0.19, x: 'center' },
    { id: 'oversized', name: 'Oversized', desc: 'Full print width', descf: 'Fills the print area', w: 'full', top: 0.5, wf: 1, topf: 0.03, x: 'center' },
  ];

  const WARPS = [
    { id: 'none', name: 'None' },
    { id: 'arc_up', name: 'Arc up' },
    { id: 'arc_down', name: 'Arc down' },
    { id: 'circle', name: 'Circle' },
    { id: 'slant', name: 'Slant' },
  ];

  const uid = () => 'o' + Math.random().toString(36).slice(2, 9);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const r2 = (n) => Math.round(n * 100) / 100;
  const isMobile = () => window.matchMedia('(max-width: 989px)').matches;

  window.gplEditorMixin = {
    // ---- extra state ----
    designs: {},                          // "Color|Area" -> { objects: [...] } in zone units
    fonts: FONTS,
    fontGroups: [...new Set(FONTS.map(f => f.group))],
    placements: PLACEMENTS,
    warps: WARPS,
    panel: 'product',                     // rail tab: product | layers | files | text | edit
    sheet: false,                         // mobile: is the tool sheet open above the dock
    zoom: 1,
    histTick: 0,                          // bumps so canUndo()/canRedo() re-evaluate
    library: [],                          // uploaded artwork, shared across products
    colorSearch: '',
    chip: { show: false, x: 0, y: 0, text: '' },
    roster: {},                           // "Color" -> [{id, name, number, size, qty}]
    team: {},                             // "Color" -> true when ordering from the roster
    pasteOpen: '',
    progressMsg: '',
    sel: {
      has: false, id: '', type: '', text: '', fontFamily: 'Anton', fontSize: 140, fill: '#FFFFFF',
      stroke: '#000000', strokeWidth: 0, fontWeight: '400', fontStyle: 'normal', charSpacing: 0,
      lineHeight: 1.1, textAlign: 'center', warp: 'none', warpAmt: 50,
      xIn: 0, yIn: 0, wIn: 0, hIn: 0, angle: 0, locked: false, placement: 'free', flipX: false, flipY: false,
      role: '',                           // '' | 'name' | 'number' — team roster substitution
    },

    // ---- fabric state ----
    fx() {
      let s = STORE.get(this.$root);
      if (!s) { s = { canvas: null, ro: null, loading: false, history: {}, lastJson: {} }; STORE.set(this.$root, s); }
      return s;
    },
    areaDef(name) { return this.areas.find(a => a.name === (name || this.activePrintArea)); },
    // A zone is "calibrated" only when the product data gives it a real physical
    // width. Without that we know where the artwork sits on the photo but NOT how
    // big it prints, so no inch figure may be shown, stored or used for a proof.
    isCalibrated(name) { const a = this.areaDef(name); return !!(a && a.w_in > 0); },
    areaWIn(name) { const a = this.areaDef(name); return (a && a.w_in) || 0; },
    areaHIn(name) {
      const a = this.areaDef(name); if (!a || !a.w_in) return 0;
      if (a.h_in) return a.h_in;
      return r2(a.w_in * (a.zone.h / a.zone.w));
    },
    // px per inch on the stage; 0 when the zone has no real-world size
    ppi(name) { const n = name || this.activePrintArea; const z = this.zonePx(n); return (z && this.isCalibrated(n)) ? z.w / this.areaWIn(n) : 0; },
    unit(name) { return this.isCalibrated(name || this.activePrintArea) ? 'in' : '%'; },
    zoneLabel(name) { return this.isCalibrated(name) ? (this.areaWIn(name) + ' × ' + this.areaHIn(name) + ' in') : ''; },
    isLabelArea(name) { const a = this.areaDef(name); return !!(a && a.view === 'inside_label'); },
    // Areas with an illustrated view (inside label) have no product photo: draw a
    // colour-tinted collar illustration instead. Data URLs draw on canvas untainted.
    viewImage(color, area) {
      const a = this.areaDef(area);
      if (a && a.view === 'inside_label') return this.insideLabelSvg(this.hexFor(color || this.activeColor));
      return this.mockupFor(color, area);
    },
    currentMockup() { return this.viewImage(this.previewColorName || this.activeColor, this.activePrintArea); },
    insideLabelSvg(hex) {
      const h = (hex || '#888888').replace('#', '');
      const rgb = h.length === 3 ? h.split('').map(c => parseInt(c + c, 16)) : [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
      const shade = (k) => 'rgb(' + rgb.map(v => Math.round(v * k)).join(',') + ')';
      const light = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 > 150;
      const stitch = light ? 'rgba(0,0,0,0.28)' : 'rgba(255,255,255,0.35)';
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000" height="1000">'
        + '<rect width="1000" height="1000" fill="#F4F4F4"/>'
        + '<path d="M0,1000 L0,300 C80,240 170,200 260,180 C360,160 420,150 500,150 C580,150 640,160 740,180 C830,200 920,240 1000,300 L1000,1000 Z" fill="' + hex + '"/>'
        + '<path d="M110,330 C250,215 400,190 500,190 C600,190 750,215 890,330 C750,265 600,245 500,245 C400,245 250,265 110,330 Z" fill="' + shade(0.72) + '"/>'
        + '<path d="M110,330 C250,265 400,245 500,245 C600,245 750,265 890,330" fill="none" stroke="' + stitch + '" stroke-width="4" stroke-dasharray="14 10"/>'
        + '<path d="M0,300 C80,240 170,200 260,180" fill="none" stroke="' + stitch + '" stroke-width="3" stroke-dasharray="12 9"/>'
        + '<path d="M740,180 C830,200 920,240 1000,300" fill="none" stroke="' + stitch + '" stroke-width="3" stroke-dasharray="12 9"/>'
        + '</svg>';
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    },
    // Chest placements only make sense on a big panel: a calibrated area at least
    // 8in wide, or an uncalibrated one whose zone covers a torso-sized part of the
    // photo (sleeve and cap panels are much smaller than that).
    placementsFor(name) {
      const a = this.areaDef(name); if (!a) return [];
      if (this.isCalibrated(name)) return this.areaWIn(name) >= 8 ? PLACEMENTS : [];
      return a.zone.w >= 0.3 ? PLACEMENTS : [];
    },
    placementDesc(p) { return this.isCalibrated() ? p.desc : (p.descf || p.desc); },
    zoneFactor(areaName) {
      const z = this.zonePx(areaName || this.activePrintArea);
      return z ? z.w / ZU : 1;
    },
    designKey(color, area) { return (color || this.activeColor) + '|' + (area || this.activePrintArea); },
    designFor(color, area) { return this.designs[this.designKey(color, area)] || { objects: [] }; },
    designHasObjects(color, area) { return this.designFor(color, area).objects.length > 0; },
    designCount(color, area) { return this.designFor(color, area).objects.length; },

    // ---- editor bootstrap (overrides base) ----
    initFabric() {
      if (!window.fabric) return;
      const el = this.$refs.fcanvas;
      const stage = this.stageEl();
      if (!el || !stage) return;
      const fx = this.fx();
      this.loadLibrary();
      fabric.Object.prototype.set({
        cornerColor: '#D71920', cornerStrokeColor: '#FFFFFF', borderColor: '#D71920',
        cornerSize: 11, transparentCorners: false, lockScalingFlip: true, borderScaleFactor: 1.5,
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
      // the stage scrolls inside its viewport when zoomed — keep Fabric's pointer offset honest
      const vp = this.$root.querySelector('[data-gpl-viewport]');
      if (vp) vp.addEventListener('scroll', () => fx.canvas.calcOffset(), { passive: true });
      window.addEventListener('scroll', () => fx.canvas.calcOffset(), { passive: true });

      fx.canvas.on('object:moving', e => this.clampToZone(e.target));
      fx.canvas.on('object:scaling', e => this.clampToZone(e.target));
      fx.canvas.on('object:rotating', e => this.clampToZone(e.target));
      fx.canvas.on('object:modified', e => {
        this.clampToZone(e.target);
        if (e.target) e.target._gplPlacement = 'free';
        this.saveDesign(); this.syncSel(); fx.canvas.requestRenderAll();
      });
      fx.canvas.on('selection:created', () => this.onSelect());
      fx.canvas.on('selection:updated', () => this.onSelect());
      fx.canvas.on('selection:cleared', () => this.onSelect());
      fx.canvas.on('after:render', () => this.updateChip());
      fx.canvas.on('text:changed', () => { this.syncSel(); this.saveDesign(); });
      // keyboard: delete / nudge / undo / duplicate unless typing in a field
      this._onKey = (ev) => {
        if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
        const o = fx.canvas.getActiveObject();
        const meta = ev.metaKey || ev.ctrlKey;
        if (meta && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? this.redo() : this.undo(); return; }
        if (meta && ev.key.toLowerCase() === 'd' && o) { ev.preventDefault(); this.duplicateSelected(); return; }
        if (!o || o.isEditing) return;
        if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); this.deleteSelected(); return; }
        const step = ev.shiftKey ? 10 : 1;
        const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
        if (nudge) {
          ev.preventDefault();
          o.left += nudge[0]; o.top += nudge[1]; o.setCoords(); this.clampToZone(o);
          o._gplPlacement = 'free'; fx.canvas.requestRenderAll(); this.saveDesign(); this.syncSel();
        }
      };
      document.addEventListener('keydown', this._onKey);
      this.loadAreaIntoFabric();
    },
    clampToZone(o) {
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
    },
    onSelect() {
      this.syncSel();
      if (isMobile()) {
        if (this.sel.has) { this.panel = 'edit'; this.sheet = true; }
        else if (this.panel === 'edit') this.panel = 'layers';
      }
    },
    // rail tabs: on mobile a second tap on the active tab closes the sheet
    openPanel(tab) {
      if (isMobile() && this.sheet && this.panel === tab) { this.sheet = false; return; }
      this.panel = tab; this.sheet = true;
    },

    // ---- (de)serialisation in zone units ----
    serializeObject(o) {
      const z = this.zonePx(this.activePrintArea);
      if (!z) return null;
      const f = z.w / ZU;
      const base = {
        id: o._gplId || (o._gplId = uid()),
        type: o.type === 'image' ? 'image' : 'text',
        cx: +((o.left - z.x) / f).toFixed(2),
        cy: +((o.top - z.y) / f).toFixed(2),
        angle: Math.round(o.angle || 0),
        flipX: !!o.flipX, flipY: !!o.flipY,
        locked: !!o._gplLocked,
        placement: o._gplPlacement || 'free',
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
        base.fontStyle = o.fontStyle || 'normal';
        base.fontSize = +((o.fontSize * (o.scaleY || 1)) / f).toFixed(2);
        base.fill = o.fill;
        base.stroke = o.stroke || '';
        base.strokeWidth = +(((o.strokeWidth || 0) * (o.scaleY || 1)) / f).toFixed(2);
        base.charSpacing = o.charSpacing || 0;
        base.lineHeight = o.lineHeight || 1.1;
        base.textAlign = o.textAlign || 'center';
        base.warp = o._gplWarp || 'none';
        base.warpAmt = o._gplWarpAmt == null ? 50 : o._gplWarpAmt;
        if (o._gplRole) base.role = o._gplRole;
      }
      return base;
    },
    saveDesign(opts) {
      const fx = this.fx();
      if (!fx.canvas || fx.loading) return;
      if (!this.zonePx(this.activePrintArea)) return;   // stage not measured yet
      const seen = new Set();
      const objs = fx.canvas.getObjects().map(o => this.serializeObject(o))
        .filter(d => d && !seen.has(d.id) && seen.add(d.id));
      const key = this.designKey();
      const prev = this.designFor().objects;
      const json = JSON.stringify(objs);
      if (json === JSON.stringify(prev)) return;
      if (!(opts && opts.noHistory)) this.pushHistory(key, clone(prev));
      if (objs.length) this.designs[key] = { objects: objs };
      else delete this.designs[key];
      this.persist();
    },
    applyLock(o, locked) {
      o._gplLocked = !!locked;
      o.set({ lockMovementX: !!locked, lockMovementY: !!locked, lockScalingX: !!locked, lockScalingY: !!locked, lockRotation: !!locked, hasControls: !locked });
    },
    // Text warp: arcs/circle use Fabric's text-on-path; slant is a skew. Path is
    // rebuilt from the text's natural width so it always fits the whole string.
    applyWarp(t, warp, amt) {
      t._gplWarp = warp || 'none';
      t._gplWarpAmt = amt == null ? 50 : amt;
      t.set({ path: null, skewX: 0 });
      t.initDimensions();
      if (warp === 'slant') { t.set({ skewX: -Math.round((amt / 100) * 30) }); t.setCoords(); return; }
      if (warp !== 'arc_up' && warp !== 'arc_down' && warp !== 'circle') { t.setCoords(); return; }
      const k = Math.max(0.05, Math.min(1, amt / 100));
      const c = Math.max(4, t.width) * 1.02;               // arc length = text width
      let d, r, len;
      if (warp === 'circle') {
        r = c / (2 * Math.PI * k);
        const half = (c / 2) / r;                          // centre the text at 12 o'clock
        const a0 = -Math.PI / 2 - half;
        const p = (a) => (r * Math.cos(a)).toFixed(2) + ',' + (r * Math.sin(a)).toFixed(2);
        d = 'M ' + p(a0) + ' A ' + r + ' ' + r + ' 0 1 1 ' + p(a0 + Math.PI) + ' A ' + r + ' ' + r + ' 0 1 1 ' + p(a0);
        len = 2 * Math.PI * r;
      } else {
        const theta = k * Math.PI;                         // up to a half circle
        r = c / theta;
        const mid = warp === 'arc_up' ? -Math.PI / 2 : Math.PI / 2;
        const sweep = warp === 'arc_up' ? 1 : 0;
        const a0 = warp === 'arc_up' ? mid - theta / 2 : mid + theta / 2;
        const a1 = warp === 'arc_up' ? mid + theta / 2 : mid - theta / 2;
        const p = (a) => (r * Math.cos(a)).toFixed(2) + ',' + (r * Math.sin(a)).toFixed(2);
        d = 'M ' + p(a0) + ' A ' + r + ' ' + r + ' 0 ' + (theta > Math.PI ? 1 : 0) + ' ' + sweep + ' ' + p(a1);
        len = c;
      }
      const path = new fabric.Path(d, { fill: '', stroke: '', visible: false, objectCaching: false });
      t.set({ path, pathAlign: 'center', pathSide: 'left', pathStartOffset: Math.max(0, (len - t.width) / 2) });
      t.initDimensions();
      t.setCoords();
    },
    // build a fabric object from a stored one, at a given zone rect (px)
    enliven(d, z) {
      if (!z || !(z.w > 0)) return Promise.resolve(null);
      const f = z.w / ZU;
      const num = (v, fb) => (typeof v === 'number' && isFinite(v) ? v : fb);
      const common = {
        left: z.x + num(d.cx, ZU / 2) * f, top: z.y + num(d.cy, ZU / 2) * f, angle: num(d.angle, 0),
        originX: 'center', originY: 'center', flipX: !!d.flipX, flipY: !!d.flipY,
      };
      return new Promise((resolve) => {
        if (d.type === 'image') {
          fabric.Image.fromURL(d.src, (img) => {
            if (!img) return resolve(null);
            img.set(common);
            img.scaleToWidth(Math.max(1, d.w * f));
            img._gplId = d.id; img._gplSrc = d.src; img._gplFilename = d.filename || ''; img._gplPlacement = d.placement || 'free';
            img.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
            this.applyLock(img, d.locked);
            resolve(img);
          }, { crossOrigin: 'anonymous' });
        } else {
          const t = new fabric.Text(d.text || '', Object.assign(common, {
            fontFamily: d.fontFamily || 'Anton',
            fontWeight: d.fontWeight || '400',
            fontStyle: d.fontStyle || 'normal',
            fontSize: Math.max(4, (d.fontSize || 140) * f),
            fill: d.fill || '#FFFFFF',
            stroke: d.stroke || '',
            strokeWidth: (d.strokeWidth || 0) * f,
            paintFirst: 'stroke',
            charSpacing: d.charSpacing || 0,
            lineHeight: d.lineHeight || 1.1,
            textAlign: d.textAlign || 'center',
            objectCaching: false,
          }));
          t._gplId = d.id; t._gplPlacement = d.placement || 'free'; t._gplRole = d.role || '';
          t.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
          this.applyWarp(t, d.warp || 'none', d.warpAmt == null ? 50 : d.warpAmt);
          this.applyLock(t, d.locked);
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
      // Only the newest load may touch the canvas; it clears + repopulates in one
      // synchronous step after its images (and fonts) have arrived.
      const seq = (fx.loadSeq = (fx.loadSeq || 0) + 1);
      fx.loading = true;
      // keep the current selection across reloads (zoom, undo, resize)
      const keep = fx.canvas.getActiveObject();
      const keepId = keep && keep.type !== 'activeSelection' ? keep._gplId : null;
      const design = this.designFor(color, area);
      await Promise.all(design.objects.filter(d => d.type === 'text').map(d => this.ensureFont(d.fontFamily, d.fontWeight, d.fontStyle)));
      const objs = await Promise.all(design.objects.map(d => this.enliven(d, z)));
      if (seq !== fx.loadSeq) return;                                    // superseded
      if (this.activePrintArea !== area || this.activeColor !== color) { fx.loading = false; return; }
      fx.canvas.clear();
      objs.filter(Boolean).forEach(o => fx.canvas.add(o));
      fx.canvas.discardActiveObject();
      const again = keepId && fx.canvas.getObjects().find(o => o._gplId === keepId);
      if (again) fx.canvas.setActiveObject(again);
      fx.canvas.requestRenderAll();
      fx.loading = false;
      this.syncSel();
    },
    savePlacement() { this.saveDesign(); },   // base name, kept for safety

    // ---- history ----
    pushHistory(key, prevObjs) {
      const h = this.fx().history;
      const s = h[key] || (h[key] = { undo: [], redo: [] });
      s.undo.push(prevObjs);
      if (s.undo.length > HISTORY_MAX) s.undo.shift();
      s.redo = [];
      this.histTick++;
    },
    canUndo() { this.histTick; const s = this.fx().history[this.designKey()]; return !!(s && s.undo.length); },
    canRedo() { this.histTick; const s = this.fx().history[this.designKey()]; return !!(s && s.redo.length); },
    undo() { this.stepHistory('undo'); },
    redo() { this.stepHistory('redo'); },
    stepHistory(dir) {
      const key = this.designKey();
      const s = this.fx().history[key];
      if (!s || !s[dir].length) return;
      const cur = clone(this.designFor().objects);
      const next = s[dir].pop();
      s[dir === 'undo' ? 'redo' : 'undo'].push(cur);
      if (next.length) this.designs[key] = { objects: next }; else delete this.designs[key];
      this.histTick++;
      this.persist();
      this.loadAreaIntoFabric();
    },

    // ---- selection <-> panel ----
    // Measurements in the zone's display unit: real inches when the print area is
    // calibrated, otherwise percent of the print area.
    inchesOf(o) {
      const z = this.zonePx(this.activePrintArea);
      if (!o || !z) return { x: 0, y: 0, w: 0, h: 0 };
      const b = o.getBoundingRect(true, true);
      const p = this.ppi();
      if (p > 0) return { x: r2((b.left - z.x) / p), y: r2((b.top - z.y) / p), w: r2(b.width / p), h: r2(b.height / p) };
      return { x: r2(((b.left - z.x) / z.w) * 100), y: r2(((b.top - z.y) / z.h) * 100), w: r2((b.width / z.w) * 100), h: r2((b.height / z.h) * 100) };
    },
    // one display unit expressed in stage px, per axis
    unitPx(axis) {
      const p = this.ppi(); if (p > 0) return p;
      const z = this.zonePx(this.activePrintArea); if (!z) return 1;
      return (axis === 'y' || axis === 'h') ? z.h / 100 : z.w / 100;
    },
    syncSel() {
      const fx = this.fx();
      const o = fx.canvas && fx.canvas.getActiveObject();
      if (!o || o.type === 'activeSelection') { this.sel.has = false; this.sel.id = ''; this.sel.type = ''; this.updateChip(); return; }
      const f = this.zoneFactor();
      const inch = this.inchesOf(o);
      Object.assign(this.sel, {
        has: true, id: o._gplId || '', type: o.type === 'image' ? 'image' : 'text',
        xIn: inch.x, yIn: inch.y, wIn: inch.w, hIn: inch.h, angle: Math.round(o.angle || 0),
        locked: !!o._gplLocked, placement: o._gplPlacement || 'free', flipX: !!o.flipX, flipY: !!o.flipY,
      });
      if (this.sel.type === 'text') {
        Object.assign(this.sel, {
          text: o.text, fontFamily: o.fontFamily, fontWeight: String(o.fontWeight || '400'), fontStyle: o.fontStyle || 'normal',
          fontSize: Math.round((o.fontSize * (o.scaleY || 1)) / f), fill: o.fill, stroke: o.stroke || '#000000',
          strokeWidth: Math.round(((o.strokeWidth || 0) * (o.scaleY || 1)) / f), charSpacing: o.charSpacing || 0,
          lineHeight: o.lineHeight || 1.1, textAlign: o.textAlign || 'center',
          warp: o._gplWarp || 'none', warpAmt: o._gplWarpAmt == null ? 50 : o._gplWarpAmt,
          role: o._gplRole || '',
        });
      }
      this.updateChip();
    },
    async applySel() {
      const fx = this.fx();
      const o = fx.canvas && fx.canvas.getActiveObject();
      if (!o || this.sel.type !== 'text') return;
      const f = this.zoneFactor();
      const font = FONTS.find(x => x.name === this.sel.fontFamily) || FONTS[0];
      if (!font.weights.includes(this.sel.fontWeight)) this.sel.fontWeight = font.weights.includes('700') ? '700' : font.weights[0];
      if (!font.italic) this.sel.fontStyle = 'normal';
      await this.ensureFont(this.sel.fontFamily, this.sel.fontWeight, this.sel.fontStyle);
      o.set({
        text: String(this.sel.text || '').slice(0, 120),
        fontFamily: this.sel.fontFamily,
        fontWeight: this.sel.fontWeight,
        fontStyle: this.sel.fontStyle,
        fontSize: Math.max(4, this.sel.fontSize * f),
        scaleX: 1, scaleY: 1,
        fill: this.sel.fill,
        stroke: this.sel.strokeWidth > 0 ? this.sel.stroke : '',
        strokeWidth: this.sel.strokeWidth * f,
        paintFirst: 'stroke',
        charSpacing: Number(this.sel.charSpacing) || 0,
        lineHeight: Number(this.sel.lineHeight) || 1.1,
        textAlign: this.sel.textAlign,
      });
      this.applyWarp(o, this.sel.warp, Number(this.sel.warpAmt));
      o._gplRole = this.sel.role || '';
      this.clampToZone(o);
      fx.canvas.requestRenderAll();
      this.saveDesign();
      this.syncSel();
    },
    ensureFont(family, weight, style) {
      try { return document.fonts.load((style === 'italic' ? 'italic ' : '') + (weight || '400') + ' 40px "' + family + '"'); } catch (e) { return Promise.resolve(); }
    },
    fontMeta(name) { return FONTS.find(f => f.name === name) || FONTS[0]; },
    fontsIn(group) { return FONTS.filter(f => f.group === group); },

    // ---- transforms (display unit: inches when calibrated, else % of print area) ----
    withSel(fn) {
      const fx = this.fx(); const o = fx.canvas && fx.canvas.getActiveObject();
      const z = this.zonePx(this.activePrintArea);
      if (!o || o.type === 'activeSelection' || !z) return;
      fn(o, z, this.unitPx('x'));
      this.clampToZone(o);
      o.setCoords(); fx.canvas.requestRenderAll();
      this.saveDesign(); this.syncSel();
    },
    setPosIn(axis, val) {
      const v = Number(val); if (isNaN(v)) return;
      this.withSel((o, z) => {
        const u = this.unitPx(axis);
        const b = o.getBoundingRect(true, true);
        if (axis === 'x') o.left += (z.x + v * u) - b.left; else o.top += (z.y + v * u) - b.top;
        o._gplPlacement = 'free';
      });
    },
    setDimIn(axis, val) {
      const v = Number(val); if (!(v > 0)) return;
      this.withSel((o, z) => {
        const u = this.unitPx(axis);
        const b = o.getBoundingRect(true, true);
        const s = (v * u) / (axis === 'w' ? b.width : b.height);
        if (o.type === 'image') { o.scaleX *= s; o.scaleY *= s; }
        else { o.set({ fontSize: o.fontSize * s * (o.scaleY || 1), scaleX: 1, scaleY: 1, strokeWidth: (o.strokeWidth || 0) * s }); this.applyWarp(o, o._gplWarp, o._gplWarpAmt); }
        o._gplPlacement = 'free';
      });
    },
    setAngle(val) {
      const v = Number(val); if (isNaN(v)) return;
      this.withSel((o) => { o.rotate(((v % 360) + 360) % 360); });
    },
    flip(axis) { this.withSel((o) => { if (axis === 'x') o.flipX = !o.flipX; else o.flipY = !o.flipY; }); },
    align(kind) {
      this.withSel((o, z) => {
        const b = o.getBoundingRect(true, true);
        if (kind === 'left') o.left += z.x - b.left;
        if (kind === 'hcenter') o.left += (z.x + z.w / 2) - (b.left + b.width / 2);
        if (kind === 'right') o.left += (z.x + z.w) - (b.left + b.width);
        if (kind === 'top') o.top += z.y - b.top;
        if (kind === 'vcenter') o.top += (z.y + z.h / 2) - (b.top + b.height / 2);
        if (kind === 'bottom') o.top += (z.y + z.h) - (b.top + b.height);
        o._gplPlacement = 'free';
      });
    },
    applyPlacement(id) {
      const pl = PLACEMENTS.find(p => p.id === id);
      if (!pl) return;
      if (pl.id === 'free') { this.withSel((o) => { o._gplPlacement = 'free'; }); return; }
      this.withSel((o, z) => {
        const cal = this.isCalibrated();
        const p = cal ? this.ppi() : 0;
        // calibrated: real inches. uncalibrated: the same placement as a fraction of the zone.
        const targetPx = cal
          ? (pl.w === 'full' ? this.areaWIn() : Math.min(pl.w, this.areaWIn())) * p
          : (pl.wf != null ? pl.wf : 1) * z.w;
        const topPx = cal ? pl.top * p : (pl.topf != null ? pl.topf : 0) * z.h;
        const offPx = cal ? 1.5 * p : 0.12 * z.w;      // left-chest offset from centre
        const b0 = o.getBoundingRect(true, true);
        const s = targetPx / b0.width;
        if (o.type === 'image') { o.scaleX *= s; o.scaleY *= s; }
        else { o.set({ fontSize: o.fontSize * s * (o.scaleY || 1), scaleX: 1, scaleY: 1, strokeWidth: (o.strokeWidth || 0) * s }); this.applyWarp(o, o._gplWarp, o._gplWarpAmt); }
        o.setCoords();
        const b = o.getBoundingRect(true, true);
        let left;
        if (pl.x === 'left_chest') left = z.x + z.w / 2 + offPx;               // wearer's left = viewer's right
        else left = z.x + z.w / 2 - b.width / 2;
        o.left += left - b.left;
        o.top += (z.y + topPx) - b.top;
        o._gplPlacement = pl.id;
      });
    },
    toggleLock(id) {
      const fx = this.fx();
      const o = id ? fx.canvas.getObjects().find(x => x._gplId === id) : fx.canvas.getActiveObject();
      if (!o) return;
      this.applyLock(o, !o._gplLocked);
      fx.canvas.requestRenderAll(); this.saveDesign(); this.syncSel();
    },

    // ---- size chip under the selection ----
    updateChip() {
      const fx = this.fx();
      const o = fx.canvas && fx.canvas.getActiveObject();
      if (!o || o.type === 'activeSelection') { if (this.chip.show) this.chip.show = false; return; }
      const b = o.getBoundingRect(true, true);
      const i = this.inchesOf(o);
      const text = this.isCalibrated()
        ? (i.w.toFixed(2) + ' × ' + i.h.toFixed(2) + ' in · ' + i.y.toFixed(1) + ' in from top')
        : (Math.round(i.w) + '% × ' + Math.round(i.h) + '% of print area');
      if (this.chip.text !== text || Math.abs(this.chip.x - (b.left + b.width / 2)) > 0.5 || Math.abs(this.chip.y - (b.top + b.height)) > 0.5 || !this.chip.show) {
        Object.assign(this.chip, { show: true, x: b.left + b.width / 2, y: b.top + b.height, text });
      }
    },

    // ---- zoom ----
    zoomIn() { const i = ZOOMS.indexOf(this.zoom); this.zoom = ZOOMS[Math.min(ZOOMS.length - 1, i + 1)]; },
    zoomOut() { const i = ZOOMS.indexOf(this.zoom); this.zoom = ZOOMS[Math.max(0, i - 1)]; },
    zoomReset() { this.zoom = 1; },

    // ---- tools ----
    async addText(preset) {
      const fx = this.fx();
      const z = this.zonePx(this.activePrintArea);
      if (!fx.canvas || !z) return;
      const f = z.w / ZU;
      const p = Object.assign({
        text: 'YOUR TEXT', fontFamily: 'Anton', fontWeight: '400', fontStyle: 'normal', fontSize: 140,
        fill: this.isLight(this.activeColor) ? '#111111' : '#FFFFFF', stroke: '', strokeWidth: 0, charSpacing: 0,
        lineHeight: 1.1, textAlign: 'center', warp: 'none', warpAmt: 50,
      }, preset || {});
      await this.ensureFont(p.fontFamily, p.fontWeight, p.fontStyle);
      const t = await this.enliven(Object.assign({ id: uid(), type: 'text', cx: ZU / 2, cy: (z.h / f) / 2, angle: 0 }, p), z);
      // never larger than the zone
      this.clampToZone(t);
      fx.canvas.add(t);
      fx.canvas.setActiveObject(t);
      fx.canvas.requestRenderAll();
      this.saveDesign();
      this.syncSel();
      if (isMobile()) { this.panel = 'edit'; this.sheet = true; }
    },
    addNumber() {
      const dark = this.isLight(this.activeColor);
      return this.addText({
        text: '00', fontFamily: 'Anton', fontSize: 420,
        fill: dark ? '#111111' : '#FFFFFF', stroke: dark ? '#FFFFFF' : '#111111', strokeWidth: 14, charSpacing: 20,
      });
    },
    // Inside label starter: brand / size / origin lines inside the 3 × 3 in tag area
    async addLabelTemplate() {
      const dark = this.isLight(this.activeColor);
      const z = this.zonePx(this.activePrintArea); if (!z) return;
      const f = z.w / ZU; const hZ = z.h / f;
      const fill = dark ? '#111111' : '#FFFFFF';
      await this.addText({ text: 'YOUR BRAND', fontFamily: 'Montserrat', fontWeight: '800', fontSize: 95, charSpacing: 60, fill, cy: hZ * 0.3 });
      await this.addText({ text: 'M', fontFamily: 'Montserrat', fontWeight: '700', fontSize: 150, fill, cy: hZ * 0.53 });
      await this.addText({ text: 'MADE IN CANADA', fontFamily: 'Montserrat', fontWeight: '400', fontSize: 58, charSpacing: 120, fill, cy: hZ * 0.74 });
    },
    async addNameNumber() {
      const dark = this.isLight(this.activeColor);
      const z = this.zonePx(this.activePrintArea); if (!z) return;
      const f = z.w / ZU; const hZ = z.h / f;
      await this.addText({ text: 'NAME', fontFamily: 'Anton', fontSize: 150, charSpacing: 60, cy: hZ * 0.22, role: 'name' });
      await this.addText({ text: '00', fontFamily: 'Anton', fontSize: 460, fill: dark ? '#111111' : '#FFFFFF', stroke: dark ? '#FFFFFF' : '#111111', strokeWidth: 14, charSpacing: 20, cy: hZ * 0.6, role: 'number' });
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
    removeById(id) {
      const fx = this.fx();
      const o = fx.canvas && fx.canvas.getObjects().find(x => x._gplId === id);
      if (!o) return;
      fx.canvas.remove(o); fx.canvas.discardActiveObject(); fx.canvas.requestRenderAll();
      this.saveDesign(); this.syncSel();
    },
    duplicateSelected() {
      const fx = this.fx();
      const o = fx.canvas && fx.canvas.getActiveObject();
      if (!o || o.type === 'activeSelection') return;
      const d = this.serializeObject(o);
      if (!d) return;
      d.id = uid(); d.cx += 40; d.cy += 40; d.placement = 'free';
      this.enliven(d, this.zonePx(this.activePrintArea)).then(n => {
        if (!n) return;
        this.clampToZone(n);
        fx.canvas.add(n); fx.canvas.setActiveObject(n); fx.canvas.requestRenderAll();
        this.saveDesign(); this.syncSel();
      });
    },
    arrange(kind) {
      const fx = this.fx(); const o = fx.canvas && fx.canvas.getActiveObject(); if (!o) return;
      if (kind === 'forward') fx.canvas.bringForward(o);
      if (kind === 'backward') fx.canvas.sendBackwards(o);
      if (kind === 'front') fx.canvas.bringToFront(o);
      if (kind === 'back') fx.canvas.sendToBack(o);
      fx.canvas.requestRenderAll(); this.saveDesign();
    },
    bringForward() { this.arrange('forward'); },
    sendBackward() { this.arrange('backward'); },
    moveLayer(id, dir) {
      const fx = this.fx(); const o = fx.canvas && fx.canvas.getObjects().find(x => x._gplId === id); if (!o) return;
      if (dir === 'up') fx.canvas.bringForward(o); else fx.canvas.sendBackwards(o);
      fx.canvas.requestRenderAll(); this.saveDesign();
    },
    centerSelected() { this.align('hcenter'); this.align('vcenter'); },
    clearArea(color, area) {
      const key = this.designKey(color, area);
      if (this.designs[key]) this.pushHistory(key, clone(this.designs[key].objects));
      delete this.designs[key];
      delete this.artwork[this.key(color, area)];
      this.persist();
      if ((color || this.activeColor) === this.activeColor && (area || this.activePrintArea) === this.activePrintArea) this.loadAreaIntoFabric();
    },
    objectsInArea() { return this.designFor().objects; },
    layerLabel(o) { return o.type === 'image' ? (o.filename || 'Image') : (o.text || 'Text'); },
    roleLabel(o) { return o.role === 'name' ? 'Player name' : (o.role === 'number' ? 'Player number' : ''); },
    selectById(id) {
      const fx = this.fx();
      const o = fx.canvas && fx.canvas.getObjects().find(x => x._gplId === id);
      if (o) { fx.canvas.setActiveObject(o); fx.canvas.requestRenderAll(); this.syncSel(); if (isMobile()) { this.panel = 'edit'; this.sheet = true; } }
    },
    setArea(name) {
      this.activePrintArea = name;
      if (this.panel === 'edit') this.panel = 'layers';
    },

    // ---- artwork library (persisted across products) ----
    loadLibrary() {
      try { const raw = localStorage.getItem(LIB_KEY); this.library = raw ? JSON.parse(raw) : []; } catch (e) { this.library = []; }
    },
    saveLibrary() { try { localStorage.setItem(LIB_KEY, JSON.stringify(this.library.slice(0, 40))); } catch (e) {} },
    addToLibrary(item) {
      this.library = [item].concat(this.library.filter(x => x.url !== item.url)).slice(0, 40);
      this.saveLibrary();
    },
    removeFromLibrary(url) { this.library = this.library.filter(x => x.url !== url); this.saveLibrary(); },
    useLibrary(item) { return this.addImageFromUrl(item.previewUrl || item.url, item.filename); },
    previewUrlFor(url, filename) {
      // canvas can't paint PDF/HEIC/TIFF/EPS/AI; Uploadcare converts them for the preview
      return /\.(pdf|heic|tiff?|eps|ai)$/i.test(filename || url) ? url.replace(/\/[^/]*$/, '/-/format/png/-/preview/2000x2000/') : url;
    },
    thumbFor(item) { return (item.previewUrl || item.url).replace(/\/[^/]*$/, '/-/preview/200x200/'); },

    // ---- uploads: originals are kept at full resolution (no downscale) ----
    async uploadArtwork(color, area, file) {
      this.errorMsg = '';
      if (!file) return;
      const okExt = /\.(png|jpe?g|svg|webp|pdf|heic|tiff?|eps|ai)$/i;
      if (!okExt.test(file.name)) return (this.errorMsg = 'Please upload a PNG, SVG, JPG, HEIC, TIFF, WEBP, PDF, EPS or AI file.');
      if (file.size > 50 * 1024 * 1024) return (this.errorMsg = 'File is too large (max 50 MB).');
      if (!this.uploadKey) return (this.errorMsg = 'Uploads are not configured yet — please contact us to place this order.');
      const artKey = this.key(color, area);
      this.uploadingCount = (this.uploadingCount || 0) + 1;
      try {
        const url = await this.uploadBlob(file.name, file);
        const list = (this.artwork[artKey] && Array.isArray(this.artwork[artKey])) ? this.artwork[artKey] : [];
        list.push({ url, filename: file.name });
        this.artwork[artKey] = list;
        const previewUrl = this.previewUrlFor(url, file.name);
        this.addToLibrary({ url, previewUrl, filename: file.name, at: Date.now() });
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

    // ---- colour picker ----
    filteredColors() {
      const q = (this.colorSearch || '').trim().toLowerCase();
      return this.colors.filter(c => !this.openColors.includes(c.name) && (!q || c.name.toLowerCase().includes(q)));
    },
    addAllColors() { this.colors.forEach(c => { if (!this.openColors.includes(c.name)) this.openColors.push(c.name); }); this.showAddColor = false; this.persist(); },

    // ---- team roster (bulk ordering) ----
    isTeam(color) { return !!this.team[color]; },
    setTeam(color, on) {
      this.team[color] = !!on;
      if (on) {
        Object.keys(this.qty).forEach(k => { if (k.startsWith(color + '|')) delete this.qty[k]; });
        if (!this.rosterFor(color).length) this.addRow(color);
      }
      this.persist();
    },
    rosterFor(color) { return this.roster[color] || []; },
    addRow(color, row) {
      const list = this.roster[color] || (this.roster[color] = []);
      list.push(Object.assign({ id: uid(), name: '', number: '', size: '', qty: 1 }, row || {}));
      this.persist();
    },
    removeRow(color, id) { this.roster[color] = this.rosterFor(color).filter(r => r.id !== id); this.persist(); },
    setRow(color, id, field, val) {
      const r = this.rosterFor(color).find(x => x.id === id); if (!r) return;
      if (field === 'number') val = String(val || '').replace(/[^0-9]/g, '').slice(0, 3);
      if (field === 'name') val = String(val || '').slice(0, 20);
      if (field === 'qty') val = Math.max(1, parseInt(val, 10) || 1);
      r[field] = val;
      this.persist();
    },
    // Size tokens people type (S, Med, XXL…) vs. the product's own labels (SM, MD, 2XL…)
    canonSize(x) {
      const v = String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (/^(xs|xsmall|extrasmall)$/.test(v)) return 'xs';
      if (/^(s|sm|small)$/.test(v)) return 's';
      if (/^(m|md|med|medium)$/.test(v)) return 'm';
      if (/^(l|lg|large)$/.test(v)) return 'l';
      if (/^(xl|xlarge|extralarge)$/.test(v)) return 'xl';
      const nx = v.match(/^(\d)xl$/);            // 2xl, 3xl …
      if (nx) return nx[1] + 'xl';
      const xx = v.match(/^(x{2,})l$/);           // xxl, xxxl …
      if (xx) return xx[1].length + 'xl';
      return v;
    },
    matchSize(tok) {
      const c = this.canonSize(tok); if (!c) return '';
      const hit = this.sizes.find(sz => this.canonSize(sz) === c);
      return hit || '';
    },
    // "Name, 23, L" / "Name 23 L" / "#10 Garcia M" / "Jones 7 XL x2" — one player per line
    importRoster(color, text) {
      // drop untouched blank rows so the import doesn't sit under an empty one
      this.roster[color] = this.rosterFor(color).filter(r => r.name || r.number || r.size);
      String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
        const parts = line.split(/[\t,;|]+|\s{2,}/).map(x => x.trim()).filter(Boolean);
        const tokens = parts.length > 1 ? parts : line.split(/\s+/);
        let name = '', number = '', size = '', qty = 1;
        tokens.forEach(t => {
          if (!size && this.matchSize(t)) size = this.matchSize(t);
          else if (!number && /^#?\d{1,3}$/.test(t)) number = t.replace('#', '');
          else if (/^x\d{1,2}$/i.test(t)) qty = parseInt(t.slice(1), 10) || 1;
          else name = (name ? name + ' ' : '') + t;
        });
        if (name || number) this.addRow(color, { name: name.slice(0, 20), number, size, qty });
      });
    },
    rosterSummary(color) {
      const rows = this.rosterFor(color);
      const ok = rows.filter(r => r.size);
      const units = ok.reduce((a, r) => a + (parseInt(r.qty, 10) || 1), 0);
      if (!rows.length) return 'No players yet';
      return units + ' shirt' + (units === 1 ? '' : 's') + ' · ' + ok.length + ' of ' + rows.length + ' player' + (rows.length === 1 ? '' : 's') + ' have a size';
    },
    areaHasRoles(color, area) { return this.designFor(color, area).objects.some(o => o.role); },
    substitute(objects, player) {
      if (!player) return objects;
      return objects.map(o => {
        if (o.type !== 'text' || !o.role) return o;
        const v = o.role === 'name' ? (player.name || '').toUpperCase() : (player.number || '');
        return Object.assign({}, o, { text: v || o.text });
      });
    },
    // every line item to be created: grid quantities, or one row per player
    orderLines() {
      const lines = [];
      for (const color of this.openColors) {
        if (this.isTeam(color)) {
          this.rosterFor(color).forEach(r => {
            if (!r.size) return;
            lines.push({ color, size: r.size, quantity: Math.max(1, parseInt(r.qty, 10) || 1), player: { id: r.id, name: (r.name || '').trim(), number: (r.number || '').trim() } });
          });
        } else {
          for (const k in this.qty) { const [c, s] = k.split('|'); if (c === color && this.qty[k] > 0) lines.push({ color, size: s, quantity: this.qty[k], player: null }); }
        }
      }
      return lines;
    },
    totalUnits() { return this.orderLines().reduce((a, l) => a + l.quantity, 0); },
    totalPrice() { let c = 0; this.orderLines().forEach(l => { const v = this.resolvedVariant(l.color, l.size); if (v) c += v.price * l.quantity; }); return c; },
    unitsFor(color) { return this.orderLines().filter(l => l.color === color).reduce((a, l) => a + l.quantity, 0); },

    // ---- coverage / gating ----
    areasUsedFor(color) {
      return this.areas.filter(a => this.designHasObjects(color, a.name)).length;
    },
    hasArtworkFor(color) { return this.areasUsedFor(color) > 0; },
    canSubmit() {
      return this.hasArtwork() && this.totalUnits() > 0 && !this.gateMessage() && !this.submitting && !(this.uploadingCount > 0);
    },
    gateMessage() {
      if (!this.openColors.length) return 'Please select at least one colour';
      const missing = this.openColors.filter(c => !this.hasArtworkFor(c));
      if (missing.length) return 'Add a design for ' + missing.join(', ');
      const noRoster = this.openColors.filter(c => this.isTeam(c) && !this.rosterFor(c).some(r => r.size));
      if (noRoster.length) return 'Add players with a size for ' + noRoster.join(', ');
      const unsized = this.openColors.filter(c => this.isTeam(c) && this.rosterFor(c).some(r => (r.name || r.number) && !r.size));
      if (unsized.length) return 'Choose a size for every player (' + unsized.join(', ') + ')';
      if (this.totalUnits() === 0) return 'Enter quantities for at least one size';
      return '';
    },

    // ---- order data ----
    lineProperties(colorName, player) {
      const used = this.areas.map(a => a.name).filter(a => this.designHasObjects(colorName, a));
      const props = {
        'Print Method': this.methodFor(colorName),
        'Print Areas': used.join(', '),
      };
      if (player) {
        if (player.name) props['Player Name'] = player.name;
        if (player.number) props['Player Number'] = player.number;
      }
      if (this.designerNotes && this.designerNotes.trim()) props['Designer Notes'] = this.designerNotes.trim().slice(0, 500);
      used.forEach(a => {
        const d = { objects: this.substitute(this.designFor(colorName, a).objects, player) };
        const imgs = d.objects.filter(o => o.type === 'image').map(o => o.src);
        const texts = d.objects.filter(o => o.type === 'text').map(o => o.text);
        if (imgs.length) props['Artwork — ' + a] = imgs.join(' , ');
        if (texts.length) props['Text — ' + a] = texts.join(' | ').slice(0, 500);
      });
      return props;
    },
    // Render a (colour, area) design onto a static canvas at an arbitrary zone size.
    async renderDesign(color, area, zonePxRect, canvasW, canvasH, background, player) {
      const sc = new fabric.StaticCanvas(null, { width: canvasW, height: canvasH });
      if (background) {
        const bg = new fabric.Image(background, { originX: 'left', originY: 'top', left: 0, top: 0 });
        bg.scaleX = canvasW / background.width;
        bg.scaleY = canvasH / background.height;
        await new Promise(res => sc.setBackgroundImage(bg, res));
      }
      const design = { objects: this.substitute(this.designFor(color, area).objects, player) };
      await Promise.all(design.objects.filter(d => d.type === 'text').map(d => this.ensureFont(d.fontFamily, d.fontWeight, d.fontStyle)));
      const objs = await Promise.all(design.objects.map(d => this.enliven(d, zonePxRect)));
      objs.filter(Boolean).forEach(o => sc.add(o));
      sc.renderAll();
      const dataUrl = sc.toDataURL({ format: background ? 'jpeg' : 'png', quality: 0.9 });
      sc.dispose();
      return await (await fetch(dataUrl)).blob();
    },
    playerSlug(player) { return player ? '-' + ((player.name || 'player').toLowerCase().replace(/[^a-z0-9]+/g, '-') + (player.number ? '-' + player.number : '')) : ''; },
    async generatePreview(color, area, player) {
      if (!this.designHasObjects(color, area)) return null;
      const a = this.areas.find(x => x.name === area);
      const mock = await this.loadImg(this.viewImage(color, area));
      const W = 900, H = Math.round(W * mock.height / mock.width);
      const z = { x: a.zone.x * W, y: a.zone.y * H, w: a.zone.w * W, h: a.zone.h * H };
      const blob = await this.renderDesign(color, area, z, W, H, mock, player);
      const slug = s => s.toLowerCase().replace(/\s+/g, '-');
      return await this.uploadBlob('preview-' + slug(color) + '-' + slug(area) + this.playerSlug(player) + '.jpg', blob);
    },
    // Transparent proof of the print area alone at PROOF_DPI (Phase 2 replaces with 300 DPI server render)
    async generateProof(color, area, player) {
      if (!this.designHasObjects(color, area)) return null;
      const cal = this.isCalibrated(area);
      const a = this.areaDef(area);
      // Calibrated: a true physical proof at PROOF_DPI. Uncalibrated: we know the
      // artwork's proportions but not its printed size, so render a generous
      // fixed-width sheet and say so in the filename rather than assert a DPI.
      const W = cal ? Math.round(this.areaWIn(area) * PROOF_DPI) : PROOF_UNCAL_W;
      const H = cal ? Math.round(this.areaHIn(area) * PROOF_DPI) : Math.round(PROOF_UNCAL_W * (a ? a.zone.h / a.zone.w : 1.33));
      const blob = await this.renderDesign(color, area, { x: 0, y: 0, w: W, h: H }, W, H, null, player);
      const slug = s => s.toLowerCase().replace(/\s+/g, '-');
      const suffix = cal ? ('-' + PROOF_DPI + 'dpi') : '-uncalibrated';
      return await this.uploadBlob('proof-' + slug(color) + '-' + slug(area) + this.playerSlug(player) + suffix + '.png', blob);
    },
    async uploadDesignJson(color, area, player) {
      const a = this.areas.find(x => x.name === area);
      const payload = { version: 2, units: ZU, area: a, calibrated: this.isCalibrated(area),
        w_in: this.isCalibrated(area) ? this.areaWIn(area) : null,
        h_in: this.isCalibrated(area) ? this.areaHIn(area) : null,
        player: player || null, design: { objects: this.substitute(this.designFor(color, area).objects, player) } };
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const slug = s => s.toLowerCase().replace(/\s+/g, '-');
      return await this.uploadBlob('design-' + slug(color) + '-' + slug(area) + this.playerSlug(player) + '.json', blob);
    },
    async artifactsFor(color, areaNames, player) {
      const props = {};
      for (const area of areaNames) {
        const [pv, pf, dj] = await Promise.all([
          this.generatePreview(color, area, player).catch(() => null),
          this.generateProof(color, area, player).catch(() => null),
          this.uploadDesignJson(color, area, player).catch(() => null),
        ]);
        if (pv) props['Preview — ' + area] = pv;
        if (pf) props['Proof — ' + area] = pf;
        if (dj) props['_Design ' + area] = dj;
      }
      return props;
    },
    async addToCart() {
      if (!this.canSubmit()) return;
      this.submitting = true;
      this.errorMsg = '';
      this.progressMsg = 'Preparing print files…';
      const lines = this.orderLines();
      const items = [];
      try {
        // Shared artifacts once per colour (areas without player fields); per-player
        // artifacts only for the areas that carry a name/number field.
        const shared = {};
        for (const color of this.openColors) {
          const used = this.areas.map(a => a.name).filter(a => this.designHasObjects(color, a));
          const isTeam = this.isTeam(color);
          const sharedAreas = used.filter(a => !(isTeam && this.areaHasRoles(color, a)));
          shared[color] = await this.artifactsFor(color, sharedAreas, null);
        }
        let done = 0;
        for (const l of lines) {
          const v = this.resolvedVariant(l.color, l.size);
          if (!v) { this.errorMsg = 'Missing variant for ' + l.color + ' / ' + l.size; this.submitting = false; this.progressMsg = ''; return; }
          let props = Object.assign(this.lineProperties(l.color, l.player), shared[l.color] || {});
          if (l.player) {
            this.progressMsg = 'Preparing print files… player ' + (++done) + ' of ' + lines.filter(x => x.player).length;
            const roleAreas = this.areas.map(a => a.name).filter(a => this.designHasObjects(l.color, a) && this.areaHasRoles(l.color, a));
            props = Object.assign(props, await this.artifactsFor(l.color, roleAreas, l.player));
          }
          items.push({ id: v.id, quantity: l.quantity, properties: props });
        }
      } catch (e) { /* best effort — the order still carries the design JSON references it managed to upload */ }
      this.progressMsg = 'Adding to cart…';
      try {
        const res = await fetch('/cart/add.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
        if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.description || err.message || 'Could not add to cart'); }
        this.clearPersist();
        window.location.href = '/cart';
      } catch (e) {
        this.errorMsg = e.message || 'Could not add to cart — please try again.';
        this.submitting = false;
        this.progressMsg = '';
      }
    },

    // removing a colour must drop its designs too (the base only knew about artwork/placement)
    removeColor(name) {
      this.openColors = this.openColors.filter(c => c !== name);
      const prefix = name + '|';
      [this.qty, this.artwork, this.designs].forEach(map => {
        Object.keys(map).forEach(k => { if (k.startsWith(prefix)) delete map[k]; });
      });
      delete this.methodByColor[name]; delete this.roster[name]; delete this.team[name];
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
          roster: this.roster, team: this.team,
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
        if (s.roster) this.roster = s.roster;
        if (s.team) this.team = s.team;
        if (s.notes) this.designerNotes = s.notes;
        if (s.openColors && s.openColors.length) { this.openColors = s.openColors; this.activeColor = s.openColors[0]; }
      } catch (e) { /* ignore */ }
    },
  };
})();
