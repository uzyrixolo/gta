'use strict';
/* Finished print files go to the same Uploadcare project the customizer already
   uploads artwork to, so everything for an order lives in one place. */
async function uploadBuffer(name, buffer, contentType) {
  const key = process.env.UPLOADCARE_PUBLIC_KEY;
  if (!key) throw new Error('UPLOADCARE_PUBLIC_KEY is not set');
  const fd = new FormData();
  fd.append('UPLOADCARE_PUB_KEY', key);
  fd.append('UPLOADCARE_STORE', '1');
  fd.append('file', new Blob([buffer], { type: contentType || 'image/png' }), name);
  const res = await fetch('https://upload.uploadcare.com/base/', { method: 'POST', body: fd });
  if (!res.ok) throw new Error('Uploadcare rejected the file: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  const base = (process.env.UPLOADCARE_CDN_BASE || 'ucarecdn.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return 'https://' + base + '/' + data.file + '/' + encodeURIComponent(name);
}
module.exports = { uploadBuffer };
