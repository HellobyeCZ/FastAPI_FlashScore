const { chromium } = require('@playwright/test');

async function trace(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const seenReq = new Set();
  page.on('request', (req) => {
    const u = req.url();
    if (!u.includes('/2/x/feed/')) return;
    if (seenReq.has(u)) return;
    seenReq.add(u);
    const h = req.headers();
    console.log('REQ', u);
    if (h['x-fsign']) console.log('HDR x-fsign', h['x-fsign']);
    if (h['x-signature']) console.log('HDR x-signature', h['x-signature']);
  });

  const seenResp = new Set();
  page.on('response', async (res) => {
    const u = res.url();
    if (!u.includes('/2/x/feed/')) return;
    if (seenResp.has(u)) return;
    seenResp.add(u);
    try {
      const txt = await res.text();
      const sample = txt.replace(/\s+/g, ' ').slice(0, 380);
      console.log('RESP', res.status(), u);
      console.log('BODY', sample);
    } catch (e) {
      console.log('RESP', res.status(), u, 'BODY <unavailable>');
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(12000);
  await browser.close();
}

const url = process.argv[2];
if (!url) {
  console.error('Usage: node fs_trace_sport.js <url>');
  process.exit(1);
}
trace(url).catch((err) => {
  console.error(err);
  process.exit(1);
});
