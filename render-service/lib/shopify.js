'use strict';
const crypto = require('crypto');

/* Shopify signs every webhook. An unsigned or mis-signed POST is not from Shopify
   and must never be allowed to make us render (or write to an order). */
function verifyWebhook(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret || !hmacHeader) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmacHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function adminGraphQL(query, variables) {
  const shop = process.env.SHOPIFY_SHOP;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shop || !token) throw new Error('SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN are not set');
  const res = await fetch('https://' + shop + '/admin/api/2024-10/graphql.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) throw new Error('Admin API error: ' + JSON.stringify(json.errors).slice(0, 300));
  return json.data;
}

/* Attach the finished print files to the order so production can find them without
   leaving Shopify: a JSON metafield for machines, and a note for a human. */
function canWriteBackToShopify() {
  return !!(process.env.SHOPIFY_SHOP && process.env.SHOPIFY_ADMIN_TOKEN);
}

/* Writing back needs an Admin API token, which now means creating an app in
   Shopify's Dev Dashboard and installing it. That is optional: without a token the
   files are still rendered and stored, named by order number, and logged. */
async function attachPrintFiles(orderGid, files) {
  const lines = files.map(f =>
    '• ' + f.lineTitle + ' — ' + f.area + (f.player ? ' (' + f.player + ')' : '') +
    ': ' + f.url + ' [' + f.width + '×' + f.height + (f.dpi ? ' @' + f.dpi + 'dpi' : ' uncalibrated') + ']'
  ).join('\n');

  if (!canWriteBackToShopify()) return lines;
  await adminGraphQL(`
    mutation($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`, {
    metafields: [{
      ownerId: orderGid,
      namespace: 'custom',
      key: 'print_files',
      type: 'json',
      value: JSON.stringify({ generatedAt: new Date().toISOString(), files })
    }]
  });

  return lines;
}

module.exports = { verifyWebhook, adminGraphQL, attachPrintFiles, canWriteBackToShopify };
