const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = 'http://localhost:8080';
let passed = 0, failed = 0, warnings = 0;

function log(status, name, detail = '') {
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️ ';
  console.log(`${icon} [${status}] ${name}${detail ? ': ' + detail : ''}`);
  if (status === 'PASS') passed++;
  else if (status === 'FAIL') failed++;
  else warnings++;
}

function vendorRoute(page) {
  page.route('**/*-compat.js', r => {
    const f = r.request().url().split('/').pop();
    try { r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync('/home/user/crm100/vendor/' + f) }); }
    catch { r.continue(); }
  });
}

async function loginAdmin(page) {
  await page.evaluate(() => {
    document.getElementById('loginType').value = 'admin';
    document.getElementById('username').value = 'admin';
    document.getElementById('password').value = 'admin123';
    login();
  });
  await page.waitForTimeout(1000);
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
  await loginAdmin(page);

  // Seed known lifts for predictable tests
  await page.evaluate(() => {
    lifts = [
      { client: 'Alpha Ltd',   lift: 'ALPHA-001', address: '1 Alpha St', phone: '27811111111', frequency: 6, lastService: Date.now(), isFaulty: false, outstanding: 0, outstandingNote: '' },
      { client: 'Beta Corp',   lift: 'BETA-001',  address: '2 Beta Rd',  phone: '27822222222', frequency: 6, lastService: Date.now(), isFaulty: false, outstanding: 0, outstandingNote: '' },
      { client: 'Gamma Inc',   lift: 'GAMMA-001', address: '3 Gamma Ave',phone: '27833333333', frequency: 6, lastService: Date.now(), isFaulty: false, outstanding: 500, outstandingNote: 'Pre-existing debt' },
    ];
  });

  // ── 1. UI card visible ────────────────────────────────────
  console.log('\n=== 1. Import Unpaid Accounts UI ===');
  await page.evaluate(() => showTab('lifts', null));
  await page.waitForTimeout(300);

  const importCard = await page.evaluate(() => document.getElementById('unpaidCsvFileInput') !== null);
  if (importCard) log('PASS', 'Import Unpaid Accounts card present in Lifts tab');
  else log('FAIL', 'Import Unpaid Accounts card not found');

  const templateBtn = await page.$('button[onclick="downloadUnpaidTemplate()"]');
  if (templateBtn) log('PASS', 'Download Sample Template button present');
  else log('FAIL', 'Download Sample Template button missing');

  const importBtn = await page.$('button[onclick="importUnpaidCSV()"]');
  if (importBtn) log('PASS', 'Import Unpaid Accounts button present');
  else log('FAIL', 'Import Unpaid Accounts button missing');

  // ── 2. Match by Lift ID ───────────────────────────────────
  console.log('\n=== 2. Import — Match by Lift ID ===');
  const csv1 = [
    'Lift ID,Client Name,Amount Owing,Note',
    'ALPHA-001,,1200.00,Invoice #001 unpaid',
    'BETA-001,,350.75,Invoice #002 overdue',
  ].join('\n');
  const tmp1 = path.join(os.tmpdir(), 'unpaid1.csv');
  fs.writeFileSync(tmp1, csv1);
  await page.$eval('#unpaidCsvFileInput', el => el.value = '');
  await page.locator('#unpaidCsvFileInput').setInputFiles(tmp1);
  await page.evaluate(() => importUnpaidCSV());
  await page.waitForTimeout(600);

  const alpha = await page.evaluate(() => lifts.find(l => l.lift === 'ALPHA-001'));
  const beta  = await page.evaluate(() => lifts.find(l => l.lift === 'BETA-001'));
  if (alpha && alpha.outstanding === 1200) log('PASS', 'ALPHA-001 updated to R1200 by Lift ID');
  else log('FAIL', `ALPHA-001 outstanding wrong: ${alpha?.outstanding}`);
  if (alpha && alpha.outstandingNote === 'Invoice #001 unpaid') log('PASS', 'ALPHA-001 note saved');
  else log('FAIL', `ALPHA-001 note wrong: ${alpha?.outstandingNote}`);
  if (beta && beta.outstanding === 350.75) log('PASS', 'BETA-001 updated to R350.75 by Lift ID');
  else log('FAIL', `BETA-001 outstanding wrong: ${beta?.outstanding}`);

  // ── 3. Match by Client Name ───────────────────────────────
  console.log('\n=== 3. Import — Match by Client Name ===');
  const csv2 = [
    'Lift ID,Client Name,Amount Owing,Note',
    ',Alpha Ltd,999.00,Matched by client name',
  ].join('\n');
  const tmp2 = path.join(os.tmpdir(), 'unpaid2.csv');
  fs.writeFileSync(tmp2, csv2);
  await page.locator('#unpaidCsvFileInput').setInputFiles(tmp2);
  await page.evaluate(() => importUnpaidCSV());
  await page.waitForTimeout(600);

  const alphaAfter = await page.evaluate(() => lifts.find(l => l.lift === 'ALPHA-001'));
  if (alphaAfter && alphaAfter.outstanding === 999) log('PASS', 'Matched by client name — amount updated to R999');
  else log('FAIL', `Client-name match failed: ${alphaAfter?.outstanding}`);

  // ── 4. Clear a balance (amount = 0) ──────────────────────
  console.log('\n=== 4. Import — Clear Balance (set to R0) ===');
  const csv3 = [
    'Lift ID,Client Name,Amount Owing,Note',
    'BETA-001,,0,Paid in full',
  ].join('\n');
  const tmp3 = path.join(os.tmpdir(), 'unpaid3.csv');
  fs.writeFileSync(tmp3, csv3);
  await page.locator('#unpaidCsvFileInput').setInputFiles(tmp3);
  await page.evaluate(() => importUnpaidCSV());
  await page.waitForTimeout(600);

  const betaCleared = await page.evaluate(() => lifts.find(l => l.lift === 'BETA-001'));
  if (betaCleared && betaCleared.outstanding === 0) log('PASS', 'BETA-001 balance cleared to R0');
  else log('FAIL', `BETA-001 clear failed: ${betaCleared?.outstanding}`);

  // ── 5. Not-found rows reported ────────────────────────────
  console.log('\n=== 5. Import — Not-found Rows Reported ===');
  const csv4 = [
    'Lift ID,Client Name,Amount Owing,Note',
    'LIFT-GHOST,,500,Should not match',
    ',Ghost Client,500,Should not match',
  ].join('\n');
  const tmp4 = path.join(os.tmpdir(), 'unpaid4.csv');
  fs.writeFileSync(tmp4, csv4);
  await page.locator('#unpaidCsvFileInput').setInputFiles(tmp4);
  await page.evaluate(() => importUnpaidCSV());
  await page.waitForTimeout(600);

  const resultText = await page.$eval('#unpaidImportResult', el => el.innerText).catch(() => '');
  if (resultText.includes('not found') || resultText.includes('LIFT-GHOST') || resultText.includes('Ghost')) {
    log('PASS', 'Not-found rows shown in result summary');
  } else {
    log('FAIL', 'Not-found rows not reported in result', resultText);
  }

  // ── 6. Template download function exists ─────────────────
  console.log('\n=== 6. Template Download ===');
  const templateFnExists = await page.evaluate(() => typeof downloadUnpaidTemplate === 'function');
  if (templateFnExists) log('PASS', 'downloadUnpaidTemplate() function defined');
  else log('FAIL', 'downloadUnpaidTemplate() not defined');

  // ── 7. Admin sees outstanding in lift cards ───────────────
  console.log('\n=== 7. Admin — Outstanding Visible in Lift Cards ===');
  await page.evaluate(() => renderLiftCards());
  await page.waitForTimeout(300);
  const cardHtml = await page.evaluate(() => document.getElementById('liftCardsList').innerHTML);
  if (cardHtml.includes('OUTSTANDING')) log('PASS', 'Admin sees OUTSTANDING badge on lift cards');
  else log('FAIL', 'Admin does NOT see OUTSTANDING badge');

  // ── 8. Tech does NOT see outstanding ─────────────────────
  console.log('\n=== 8. Tech — Outstanding HIDDEN from Tech View ===');
  await page.evaluate(() => logout());
  await page.waitForTimeout(500);
  await page.evaluate(() => { if (techs.length === 0) initializeDemoData(); });
  await page.evaluate(() => {
    // Keep our seeded lifts with balances
    lifts = [
      { client: 'Alpha Ltd', lift: 'ALPHA-001', address: '1 Alpha St', phone: '27811111111', frequency: 6, lastService: Date.now(), isFaulty: false, outstanding: 999, outstandingNote: 'Test debt' },
    ];
    document.getElementById('loginType').value = 'tech';
    document.getElementById('username').value = 'john';
    document.getElementById('password').value = 'tech1';
    login();
  });
  await page.waitForTimeout(1000);

  if (await page.isVisible('#techApp')) {
    // Render a ticket for the lift with outstanding and check the card
    const ticketCardHtml = await page.evaluate(() => {
      tickets = [{
        ticketNumber: 'TKT-VIS-001',
        lift: lifts[0],
        tech: 'John',
        jobType: 'Service',
        scheduledDate: '2026-06-01',
        note: 'Test',
        status: 'Open',
        notes: [],
        photos: [],
        created: new Date().toISOString(),
      }];
      return renderTicketCard(tickets[0], 0);
    });

    if (!ticketCardHtml.includes('OUTSTANDING') && !ticketCardHtml.includes('Outstanding balance') && !ticketCardHtml.includes('outstanding')) {
      log('PASS', 'Tech does NOT see outstanding balance in ticket card');
    } else {
      log('FAIL', 'Outstanding balance is LEAKING to tech view');
    }

    // Also verify the tech can still see everything else normally
    if (ticketCardHtml.includes('Alpha Ltd') || ticketCardHtml.includes('ALPHA-001')) {
      log('PASS', 'Tech still sees normal ticket info (client/lift)');
    } else {
      log('WARN', 'Ticket card may not be rendering client info');
    }
  } else {
    log('FAIL', 'Tech login failed — cannot test visibility');
  }

  // ── 9. JS errors ─────────────────────────────────────────
  console.log('\n=== 9. JavaScript Errors ===');
  const ignored = ['net::ERR', 'favicon', 'Failed to fetch', 'firebase', 'Firebase',
    'firestore', 'FIRESTORE', 'Cloud Firestore', 'bad HTTP', 'AbortError'];
  const appErrors = jsErrors.filter(e => !ignored.some(p => e.toLowerCase().includes(p.toLowerCase())));
  if (appErrors.length === 0) log('PASS', 'No JS errors during session');
  else appErrors.forEach(e => log('FAIL', 'JS error', e.substring(0, 150)));

  await browser.close();
  [tmp1, tmp2, tmp3, tmp4].forEach(f => fs.unlinkSync(f));

  console.log('\n' + '═'.repeat(55));
  console.log(`  TOTAL: ${passed + failed + warnings} checks`);
  console.log(`  ✅ PASSED:   ${passed}`);
  console.log(`  ❌ FAILED:   ${failed}`);
  console.log(`  ⚠️  WARNINGS: ${warnings}`);
  console.log('═'.repeat(55));
  process.exit(failed > 0 ? 1 : 0);
})();
