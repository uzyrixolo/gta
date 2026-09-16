'use strict';
/* GTA Print Lab — print-file service.

   Turns a customizer design into a real print file. The design JSON the storefront
   already attaches to every order line is resolution independent, so the only thing
   this service adds is scale: render the same artwork at w_in * 300 rather than at
   a few hundred screen pixels.

   Two ways in:
     POST /render                — render one design, get a PNG (or a hosted URL)
     POST /webhooks/orders/create — Shopify calls this; every design on the order is
                                   rendered and the links are written back to it
*/
const express = require('express');
const { boot, renderDesign, closeBrowser } = require('./lib/render');
const { uploadBuffer } = require('./lib/uploadcare');
const { verifyWebhook, attachPrintFiles, adminGraphQL } = require('./lib/shopify');

const app = express();
const PORT = process.env.PORT || 3000;

// The webhook route needs the raw body to check Shopify's signature, so capture it
// before anything parses it away.
app.use('/webhooks', express.raw({ type: '*/*', limit: '5mb' }));
app.use(express.json({ limit: '25mb' }));

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function requireToken(req, res) {
  const expected = process.env.RENDER_TOKEN;
  if (!expected) { res.status(500).json({ error: 'RENDER_TOKEN is not configured' }); return false; }
  const got = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (got !== expected) { res.status(401).json({ error: 'bad token' }); return false; }
  return true;
}

app.get('/health', (req, res) => res.json({ ok: true, dpi: Number(process.env.PRINT_DPI || 300) }));

/* Render one design.
   body: { designUrl } or { design, w_in, h_in }, plus optional { dpi, player, upload } */
app.post('/render', async (req, res) => {
  if (!requireToken(req, res)) return;
  try {
    const body = req.body || {};
    let payload = body.design ? body : null;
    if (!payload) {
      if (!body.designUrl) return res.status(400).json({ error: 'design or designUrl required' });
      const r = await fetch(body.designUrl);
      if (!r.ok) return res.status(400).json({ error: 'could not fetch designUrl: ' + r.status });
      payload = await r.json();
    }
    const design = payload.design || payload;
    const area = (payload.area && payload.area.name) || body.area || 'Front';
    const aspect = payload.area && payload.area.zone && payload.area.zone.w
      ? payload.area.zone.h / payload.area.zone.w : 1.3333;

    const out = await renderDesign({
      design,
      widthIn: body.w_in || payload.w_in,
      heightIn: body.h_in || payload.h_in,
      aspect,
      dpi: body.dpi,
      player: body.player || payload.player || null
    });

    if (body.upload === false) {
      res.set('Content-Type', 'image/png');
      res.set('X-Print-Size', out.width + 'x' + out.height);
      res.set('X-Print-Dpi', String(out.dpi || 'uncalibrated'));
      return res.send(out.buffer);
    }
    const name = 'print-' + slug(area) + (out.dpi ? '-' + out.dpi + 'dpi' : '-uncalibrated') + '.png';
    const url = await uploadBuffer(name, out.buffer, 'image/png');
    res.json({ url, width: out.width, height: out.height, dpi: out.dpi, calibrated: out.calibrated, stats: out.stats });
  } catch (e) {
    console.error('[render]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* Shopify order webhook: render every design on the order at full resolution. */
app.post('/webhooks/orders/create', async (req, res) => {
  const raw = req.body; // Buffer, thanks to express.raw above
  if (!verifyWebhook(raw, req.get('x-shopify-hmac-sha256'))) {
    return res.status(401).send('bad signature');
  }
  // Answer Shopify immediately: rendering a 12x16in file takes seconds and Shopify
  // retries anything that does not reply within five.
  res.status(200).send('ok');

  let order;
  try { order = JSON.parse(raw.toString('utf8')); } catch (e) { return console.error('[webhook] bad json'); }

  try {
    const files = [];
    for (const item of order.line_items || []) {
      const props = {};
      (item.properties || []).forEach(p => { props[p.name] = p.value; });
      const designProps = Object.keys(props).filter(k => k.startsWith('_Design '));
      for (const key of designProps) {
        const area = key.replace('_Design ', '');
        try {
          const r = await fetch(props[key]);
          if (!r.ok) throw new Error('design fetch ' + r.status);
          const payload = await r.json();
          const aspect = payload.area && payload.area.zone && payload.area.zone.w
            ? payload.area.zone.h / payload.area.zone.w : 1.3333;
          const out = await renderDesign({
            design: payload.design || payload,
            widthIn: payload.w_in,
            heightIn: payload.h_in,
            aspect,
            player: payload.player || null
          });
          const player = props['Player Name'] || props['Player Number']
            ? [props['Player Name'], props['Player Number']].filter(Boolean).join(' ') : '';
          const name = 'order-' + order.order_number + '-' + slug(item.title).slice(0, 40)
            + '-' + slug(area) + (player ? '-' + slug(player) : '')
            + (out.dpi ? '-' + out.dpi + 'dpi' : '-uncalibrated') + '.png';
          const url = await uploadBuffer(name, out.buffer, 'image/png');
          files.push({
            lineItemId: item.id, lineTitle: item.title, variant: item.variant_title,
            area, player, url, width: out.width, height: out.height,
            dpi: out.dpi, calibrated: out.calibrated
          });
        } catch (e) {
          console.error('[webhook] ' + area + ' on line ' + item.id + ':', e.message);
          files.push({ lineItemId: item.id, lineTitle: item.title, area, error: String(e.message || e) });
        }
      }
    }
    if (!files.length) return console.log('[webhook] order ' + order.order_number + ': no customizer designs');
    const summary = await attachPrintFiles('gid://shopify/Order/' + order.id, files);
    console.log('[webhook] order ' + order.order_number + ': ' + files.length + ' print file(s)\n' + summary);
  } catch (e) {
    console.error('[webhook]', e);
  }
});

const server = app.listen(PORT, async () => {
  try {
    await boot();
    console.log('print-file service listening on ' + PORT + ' at ' + (process.env.PRINT_DPI || 300) + ' DPI');
  } catch (e) {
    console.error('boot failed:', e);
    process.exit(1);
  }
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => { await closeBrowser(); server.close(() => process.exit(0)); });
}
