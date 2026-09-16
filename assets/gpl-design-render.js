/* GTA Print Lab — shared design renderer.
   ONE implementation of "stored design object -> fabric object", used by BOTH:
     - the in-browser customizer (assets/gpl-customizer-v2-editor.js)
     - the 300 DPI print-file service (render-service/, which loads THIS very file)
   so a print file can never drift from the proof the customer approved.

   A design is stored in "zone units": the print zone is ZU units wide and every
   position/size is expressed against that, which makes it resolution independent.
   Render it by passing the zone rectangle you want it drawn into — the phone-sized
   stage, a 900px preview, or 12in x 300dpi = 3600px of print file.

   Anything here must stay pure: no Alpine, no DOM beyond fabric itself. */
(function (root) {
  var ZU = 1000;

  function num(v, fb) { return (typeof v === 'number' && isFinite(v)) ? v : fb; }

  // Text warps. Arcs and circles ride a fabric text-path; slant is a skew.
  // The path is rebuilt from the text's own width so the whole string always fits.
  function applyWarp(fabric, t, warp, amt) {
    t._gplWarp = warp || 'none';
    t._gplWarpAmt = amt == null ? 50 : amt;
    t.set({ path: null, skewX: 0 });
    t.initDimensions();
    if (warp === 'slant') { t.set({ skewX: -Math.round((amt / 100) * 30) }); t.setCoords(); return; }
    if (warp !== 'arc_up' && warp !== 'arc_down' && warp !== 'circle') { t.setCoords(); return; }
    var k = Math.max(0.05, Math.min(1, amt / 100));
    var c = Math.max(4, t.width) * 1.02;               // arc length = text width
    var d, r, len;
    if (warp === 'circle') {
      r = c / (2 * Math.PI * k);
      var half = (c / 2) / r;                          // centre the text at 12 o'clock
      var a0c = -Math.PI / 2 - half;
      var pc = function (a) { return (r * Math.cos(a)).toFixed(2) + ',' + (r * Math.sin(a)).toFixed(2); };
      d = 'M ' + pc(a0c) + ' A ' + r + ' ' + r + ' 0 1 1 ' + pc(a0c + Math.PI) + ' A ' + r + ' ' + r + ' 0 1 1 ' + pc(a0c);
      len = 2 * Math.PI * r;
    } else {
      var theta = k * Math.PI;                         // up to a half circle
      r = c / theta;
      var mid = warp === 'arc_up' ? -Math.PI / 2 : Math.PI / 2;
      var sweep = warp === 'arc_up' ? 1 : 0;
      var a0 = warp === 'arc_up' ? mid - theta / 2 : mid + theta / 2;
      var a1 = warp === 'arc_up' ? mid + theta / 2 : mid - theta / 2;
      var p = function (a) { return (r * Math.cos(a)).toFixed(2) + ',' + (r * Math.sin(a)).toFixed(2); };
      d = 'M ' + p(a0) + ' A ' + r + ' ' + r + ' 0 ' + (theta > Math.PI ? 1 : 0) + ' ' + sweep + ' ' + p(a1);
      len = c;
    }
    var path = new fabric.Path(d, { fill: '', stroke: '', visible: false, objectCaching: false });
    t.set({ path: path, pathAlign: 'center', pathSide: 'left', pathStartOffset: Math.max(0, (len - t.width) / 2) });
    t.initDimensions();
    t.setCoords();
  }

  function applyLock(o, locked) {
    o._gplLocked = !!locked;
    o.set({
      lockMovementX: !!locked, lockMovementY: !!locked, lockScalingX: !!locked,
      lockScalingY: !!locked, lockRotation: !!locked, hasControls: !locked
    });
  }

  // Build a fabric object from a stored one, positioned inside zone rect `z` (px).
  function enliven(fabric, d, z) {
    if (!z || !(z.w > 0)) return Promise.resolve(null);
    var f = z.w / ZU;
    var common = {
      left: z.x + num(d.cx, ZU / 2) * f,
      top: z.y + num(d.cy, ZU / 2) * f,
      angle: num(d.angle, 0),
      originX: 'center', originY: 'center',
      flipX: !!d.flipX, flipY: !!d.flipY
    };
    return new Promise(function (resolve) {
      if (d.type === 'image') {
        fabric.Image.fromURL(d.src, function (img) {
          if (!img) return resolve(null);
          img.set(common);
          img.scaleToWidth(Math.max(1, num(d.w, ZU * 0.8) * f));
          img._gplId = d.id; img._gplSrc = d.src; img._gplFilename = d.filename || '';
          img._gplPlacement = d.placement || 'free';
          img.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
          applyLock(img, d.locked);
          resolve(img);
        }, { crossOrigin: 'anonymous' });
      } else {
        var opts = Object.assign({}, common, {
          fontFamily: d.fontFamily || 'Anton',
          fontWeight: d.fontWeight || '400',
          fontStyle: d.fontStyle || 'normal',
          fontSize: Math.max(4, num(d.fontSize, 140) * f),
          fill: d.fill || '#FFFFFF',
          stroke: d.stroke || '',
          strokeWidth: num(d.strokeWidth, 0) * f,
          paintFirst: 'stroke',
          charSpacing: num(d.charSpacing, 0),
          lineHeight: num(d.lineHeight, 1.1),
          textAlign: d.textAlign || 'center',
          objectCaching: false
        });
        var t = new fabric.Text(d.text || '', opts);
        t._gplId = d.id; t._gplPlacement = d.placement || 'free'; t._gplRole = d.role || '';
        t.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
        applyWarp(fabric, t, d.warp || 'none', d.warpAmt == null ? 50 : d.warpAmt);
        applyLock(t, d.locked);
        resolve(t);
      }
    });
  }

  // Substitute a team roster player's name/number into the bound text layers.
  function substitute(objects, player) {
    if (!player) return objects;
    return objects.map(function (o) {
      if (o.type !== 'text' || !o.role) return o;
      var v = o.role === 'name' ? String(player.name || '').toUpperCase() : String(player.number || '');
      return Object.assign({}, o, { text: v || o.text });
    });
  }

  function fontsUsed(objects) {
    var seen = {};
    (objects || []).forEach(function (o) {
      if (o.type !== 'text') return;
      var key = (o.fontFamily || 'Anton') + '|' + (o.fontWeight || '400') + '|' + (o.fontStyle || 'normal');
      seen[key] = { family: o.fontFamily || 'Anton', weight: o.fontWeight || '400', style: o.fontStyle || 'normal' };
    });
    return Object.keys(seen).map(function (k) { return seen[k]; });
  }

  function ensureFonts(objects) {
    if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
    return Promise.all(fontsUsed(objects).map(function (f) {
      try {
        return document.fonts.load((f.style === 'italic' ? 'italic ' : '') + f.weight + ' 40px "' + f.family + '"');
      } catch (e) { return Promise.resolve(); }
    }));
  }

  /* Draw a design onto a fabric StaticCanvas.
     opts: { width, height, zone:{x,y,w,h}, background (HTMLImageElement|null), player } */
  function renderToCanvas(fabric, design, opts) {
    var objects = substitute((design && design.objects) || [], opts.player);
    var sc = new fabric.StaticCanvas(null, { width: opts.width, height: opts.height });
    return ensureFonts(objects).then(function () {
      if (!opts.background) return null;
      // setBackgroundImage wants a fabric.Image; a bare <img> throws
      var bg = new fabric.Image(opts.background, { originX: 'left', originY: 'top', left: 0, top: 0 });
      bg.scaleX = opts.width / opts.background.width;
      bg.scaleY = opts.height / opts.background.height;
      return new Promise(function (res) { sc.setBackgroundImage(bg, res); });
    }).then(function () {
      return Promise.all(objects.map(function (d) { return enliven(fabric, d, opts.zone); }));
    }).then(function (objs) {
      objs.filter(Boolean).forEach(function (o) { sc.add(o); });
      sc.renderAll();
      return sc;
    });
  }

  root.gplDesignRender = {
    ZU: ZU,
    enliven: enliven,
    applyWarp: applyWarp,
    applyLock: applyLock,
    substitute: substitute,
    fontsUsed: fontsUsed,
    ensureFonts: ensureFonts,
    renderToCanvas: renderToCanvas
  };
})(typeof window !== 'undefined' ? window : globalThis);
