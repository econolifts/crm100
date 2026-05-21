const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');
const BASE = 'http://localhost:8080';
let passed = 0, failed = 0;

function log(status, name, detail = '') {
  console.log(`${status==='PASS'?'✅':'❌'} [${status}] ${name}${detail?': '+detail:''}`);
  status === 'PASS' ? passed++ : failed++;
}

function vendorRoute(page) {
  page.route('**/*-compat.js', r => {
    const f = r.request().url().split('/').pop();
    try { r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync('/home/user/crm100/vendor/' + f) }); }
    catch { r.continue(); }
  });
}

async function runImport(page, csvContent, inputId = 'csvFileInput', fn = 'importCSV') {
  const tmp = path.join(os.tmpdir(), `test-${Date.now()}.csv`);
  fs.writeFileSync(tmp, csvContent);
  await page.locator(`#${inputId}`).setInputFiles(tmp);
  await page.evaluate(f => window[f](), fn);
  await page.waitForTimeout(500);
  fs.unlinkSync(tmp);
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await vendorRoute(page);

  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(e.message));
  page.on('dialog', d => d.accept());

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  await page.evaluate(() => {
    document.getElementById('loginType').value = 'admin';
    document.getElementById('username').value = 'admin';
    document.getElementById('password').value = 'admin123';
    login();
  });
  await page.waitForTimeout(1000);
  await page.evaluate(() => showTab('lifts', null));
  await page.waitForTimeout(300);

  // Reset lifts for predictable counts
  await page.evaluate(() => { lifts = []; });

  // ── 1. Standard 5-column format (original format) ──────────
  console.log('\n=== 1. Standard 5-Column Format ===');
  await runImport(page, [
    'Client,Address,Phone,Lift ID,Frequency',
    'Alpha Ltd,1 Alpha St,27811111111,ALPHA-001,6',
    'Beta Corp,2 Beta Rd,27822222222,BETA-001,12',
  ].join('\n'));
  let count = await page.evaluate(() => lifts.length);
  log(count === 2 ? 'PASS' : 'FAIL', 'Standard 5-column CSV imports 2 lifts', `count=${count}`);

  // ── 2. Different column order ───────────────────────────────
  console.log('\n=== 2. Different Column Order ===');
  await runImport(page, [
    'Lift ID,Client,Phone,Address,Frequency',
    'GAMMA-001,Gamma Inc,27833333333,3 Gamma Ave,3',
  ].join('\n'));
  count = await page.evaluate(() => lifts.length);
  const gamma = await page.evaluate(() => lifts.find(l => l.lift === 'GAMMA-001'));
  log(gamma ? 'PASS' : 'FAIL', 'Flexible column order — Lift ID first', `count=${count}`);
  log(gamma?.frequency === 3 ? 'PASS' : 'FAIL', 'Frequency correctly mapped', `freq=${gamma?.frequency}`);

  // ── 3. Minimal CSV — only Client and Lift ID ───────────────
  console.log('\n=== 3. Minimal CSV (Client + Lift ID only) ===');
  await runImport(page, [
    'Client,Lift ID',
    'Delta Co,DELTA-001',
    'Echo Ltd,ECHO-001',
  ].join('\n'));
  const delta = await page.evaluate(() => lifts.find(l => l.lift === 'DELTA-001'));
  const echo  = await page.evaluate(() => lifts.find(l => l.lift === 'ECHO-001'));
  log(delta ? 'PASS' : 'FAIL', '2-column CSV: Delta imported');
  log(echo  ? 'PASS' : 'FAIL', '2-column CSV: Echo imported');
  log(delta?.frequency === 6 ? 'PASS' : 'FAIL', 'Default frequency=6 applied when missing', `freq=${delta?.frequency}`);

  // ── 4. CRLF line endings (Windows Excel export) ─────────────
  console.log('\n=== 4. Windows CRLF Line Endings ===');
  await runImport(page, "Client,Lift ID\r\nFoxtrot Inc,FOX-001\r\nGolf Club,GOLF-001\r\n");
  const fox  = await page.evaluate(() => lifts.find(l => l.lift === 'FOX-001'));
  const golf = await page.evaluate(() => lifts.find(l => l.lift === 'GOLF-001'));
  log(fox  ? 'PASS' : 'FAIL', 'CRLF endings: Foxtrot imported');
  log(golf ? 'PASS' : 'FAIL', 'CRLF endings: Golf imported');

  // ── 5. Only Lift ID column (no client) ─────────────────────
  console.log('\n=== 5. Lift ID Only (no Client column) ===');
  await runImport(page, [
    'Lift ID',
    'HOTEL-001',
    'INDIA-001',
  ].join('\n'));
  const hotel = await page.evaluate(() => lifts.find(l => l.lift === 'HOTEL-001'));
  log(hotel ? 'PASS' : 'FAIL', 'Lift-ID-only CSV: HOTEL-001 imported (client defaults to lift ID)');

  // ── 6. Lifts appear in the card list after import ──────────
  console.log('\n=== 6. Cards Render After Import ===');
  await page.evaluate(() => renderLiftCards());
  await page.waitForTimeout(200);
  const cardCount = await page.evaluate(() =>
    document.querySelectorAll('#liftCardsList .lift-card-item').length
  );
  const totalLifts = await page.evaluate(() => lifts.length);
  log(cardCount === totalLifts ? 'PASS' : 'FAIL',
    `All ${totalLifts} imported lifts appear as cards`, `cards=${cardCount}`);
  log(cardCount > 0 ? 'PASS' : 'FAIL', 'Lift card list is not empty after import');

  // ── 7. Empty CSV gives a helpful message ───────────────────
  console.log('\n=== 7. Empty / Headerless CSV ===');
  const beforeEmpty = await page.evaluate(() => lifts.length);
  await runImport(page, '\n\n\n'); // only blank lines
  const afterEmpty = await page.evaluate(() => lifts.length);
  log(afterEmpty === beforeEmpty ? 'PASS' : 'FAIL', 'Empty CSV does not add lifts');

  // ── 8. Duplicate rejection still works ─────────────────────
  console.log('\n=== 8. Duplicate Rejection Still Works ===');
  const beforeDup = await page.evaluate(() => lifts.length);
  await runImport(page, [
    'Client,Lift ID',
    'Alpha Ltd,ALPHA-001',   // duplicate lift ID
    'Alpha Ltd,ALPHA-999',   // duplicate client name
  ].join('\n'));
  const afterDup = await page.evaluate(() => lifts.length);
  log(afterDup === beforeDup ? 'PASS' : 'FAIL',
    'Both duplicate lift ID and client name rejected', `before=${beforeDup} after=${afterDup}`);

  // ── 9. JS errors ───────────────────────────────────────────
  console.log('\n=== 9. JavaScript Errors ===');
  const ignored = ['net::ERR','favicon','Failed to fetch','firebase','Firebase',
    'firestore','FIRESTORE','Cloud Firestore','bad HTTP','AbortError'];
  const appErrors = jsErrors.filter(e => !ignored.some(p => e.toLowerCase().includes(p.toLowerCase())));
  if (appErrors.length === 0) { console.log('✅ [PASS] No JS errors'); passed++; }
  else appErrors.forEach(e => { console.log('❌ [FAIL] JS error: '+e.substring(0,150)); failed++; });

  await browser.close();

  console.log('\n' + '═'.repeat(55));
  console.log(`  TOTAL: ${passed+failed}  ✅ ${passed} passed  ❌ ${failed} failed`);
  console.log('═'.repeat(55));
  process.exit(failed > 0 ? 1 : 0);
})();
