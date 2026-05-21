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
  page.route('**/firebase-app-compat.js', r =>
    r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync('/home/user/crm100/vendor/firebase-app-compat.js') }));
  page.route('**/firebase-firestore-compat.js', r =>
    r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync('/home/user/crm100/vendor/firebase-firestore-compat.js') }));
  page.route('**/firebase-storage-compat.js', r =>
    r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync('/home/user/crm100/vendor/firebase-storage-compat.js') }));
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--ignore-certificate-errors'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await vendorRoute(page);

  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(e.message));
  page.on('dialog', d => d.accept()); // auto-accept all alerts/confirms

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Login as admin
  await page.evaluate(() => {
    document.getElementById('loginType').value = 'admin';
    document.getElementById('username').value = 'admin';
    document.getElementById('password').value = 'admin123';
    login();
  });
  await page.waitForTimeout(1000);
  if (!(await page.isVisible('#adminApp'))) {
    console.log('❌ Could not login — aborting'); await browser.close(); process.exit(1);
  }

  // Seed clean state for predictable tests
  await page.evaluate(() => { lifts = []; tickets = []; });

  // ═══════════════════════════════════════════════════════
  console.log('\n=== FEATURE 1: Duplicate Rejection — Manual Add Lift ===');
  // ═══════════════════════════════════════════════════════

  // Add first lift
  await page.evaluate(() => showTab('lifts', null));
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    document.getElementById('client').value = 'Acme Corp';
    document.getElementById('lift').value = 'ACME-001';
    document.getElementById('clientAddress').value = '10 Acme Rd';
    document.getElementById('clientPhone').value = '27831234567';
    document.getElementById('frequency').value = '6';
    document.getElementById('outstandingAmount').value = '0';
    document.getElementById('outstandingNote').value = '';
  });
  await page.evaluate(() => addLift());
  await page.waitForTimeout(400);
  const liftCount1 = await page.evaluate(() => lifts.length);
  if (liftCount1 === 1) log('PASS', 'First lift (ACME-001) added successfully');
  else log('FAIL', 'First lift not added', `count=${liftCount1}`);

  // Try to add same Lift ID — should be blocked
  const errsBefore = jsErrors.length;
  await page.evaluate(() => {
    document.getElementById('client').value = 'Different Client';
    document.getElementById('lift').value = 'ACME-001'; // duplicate lift ID
    document.getElementById('clientAddress').value = '99 Other St';
    document.getElementById('clientPhone').value = '27839999999';
  });
  await page.evaluate(() => addLift());
  await page.waitForTimeout(400);
  const liftCount2 = await page.evaluate(() => lifts.length);
  if (liftCount2 === 1) log('PASS', 'Duplicate Lift ID "ACME-001" rejected — count unchanged');
  else log('FAIL', 'Duplicate Lift ID was NOT rejected', `count grew to ${liftCount2}`);

  // Try to add same client name — should prompt confirm (auto-accepted) and still add
  await page.evaluate(() => {
    document.getElementById('client').value = 'Acme Corp'; // duplicate client name
    document.getElementById('lift').value = 'ACME-002';   // different lift ID
    document.getElementById('clientAddress').value = '10 Acme Rd Unit 2';
    document.getElementById('clientPhone').value = '27831234567';
  });
  await page.evaluate(() => addLift());
  await page.waitForTimeout(400);
  const liftCount3 = await page.evaluate(() => lifts.length);
  if (liftCount3 === 2) log('PASS', 'Duplicate client name prompted confirm and was accepted — second lift added');
  else log('FAIL', 'Second lift with same client name not added correctly', `count=${liftCount3}`);

  // ═══════════════════════════════════════════════════════
  console.log('\n=== FEATURE 1: Duplicate Rejection — CSV Import ===');
  // ═══════════════════════════════════════════════════════

  // Create a CSV with: 1 new, 1 duplicate lift ID, 1 duplicate client, 1 valid with outstanding
  const csvContent = [
    'Client,Address,Phone,Lift ID,Frequency,Outstanding Amount,Outstanding Note',
    'New Client A,1 New St,27840000001,NEW-001,6,0,',
    'Acme Corp,10 Acme Rd,27831234567,ACME-003,6,0,',       // duplicate client name
    'Brand New Co,5 Brand St,27840000002,ACME-001,6,0,',    // duplicate lift ID
    'Overdue Client,9 Debt Rd,27840000003,DEBT-001,6,2500.50,Invoice #456 overdue 90 days',
  ].join('\n');

  const tmpCsv = path.join(os.tmpdir(), 'test-import.csv');
  fs.writeFileSync(tmpCsv, csvContent);

  // Set the file input
  const fileInput = await page.$('#csvFileInput');
  await fileInput.setInputFiles(tmpCsv);

  const liftsBefore = await page.evaluate(() => lifts.length);
  await page.evaluate(() => importCSV());
  await page.waitForTimeout(600);
  const liftsAfter = await page.evaluate(() => lifts.length);
  const added = liftsAfter - liftsBefore;

  // Expect: NEW-001 added, DEBT-001 added → 2 imported; ACME-003 (dup client) and ACME-001 (dup lift) skipped
  if (added === 2) log('PASS', `CSV imported 2 new lifts, skipped 2 duplicates (added=${added})`);
  else log('FAIL', `CSV imported wrong count — expected 2, got ${added}`);

  // Verify duplicate lift ID was blocked
  const acme001Count = await page.evaluate(() => lifts.filter(l => l.lift === 'ACME-001').length);
  if (acme001Count === 1) log('PASS', 'Duplicate Lift ID "ACME-001" not duplicated in CSV import');
  else log('FAIL', `Lift ACME-001 appears ${acme001Count} times after import`);

  // Verify duplicate client was blocked
  const acmeCorpCount = await page.evaluate(() => lifts.filter(l => l.client === 'Acme Corp').length);
  if (acmeCorpCount === 2) log('PASS', 'Duplicate client "Acme Corp" blocked in CSV import (still 2 from earlier)');
  else log('FAIL', `Acme Corp appears ${acmeCorpCount} times — expected 2`);

  // ═══════════════════════════════════════════════════════
  console.log('\n=== FEATURE 2: Outstanding Amount — Add Lift Form ===');
  // ═══════════════════════════════════════════════════════

  // Add a lift with outstanding amount via form
  await page.evaluate(() => {
    document.getElementById('client').value = 'Debtor Corp';
    document.getElementById('lift').value = 'DEBT-FORM-001';
    document.getElementById('clientAddress').value = '5 Debt Lane';
    document.getElementById('clientPhone').value = '27845000001';
    document.getElementById('frequency').value = '6';
    document.getElementById('outstandingAmount').value = '1500.00';
    document.getElementById('outstandingNote').value = 'Invoice #789 30 days overdue';
  });
  await page.evaluate(() => addLift());
  await page.waitForTimeout(400);

  const debtorLift = await page.evaluate(() => lifts.find(l => l.lift === 'DEBT-FORM-001'));
  if (debtorLift) {
    if (debtorLift.outstanding === 1500) log('PASS', 'Outstanding amount R1500 saved to lift');
    else log('FAIL', `Outstanding amount wrong: ${debtorLift.outstanding}`);
    if (debtorLift.outstandingNote === 'Invoice #789 30 days overdue') log('PASS', 'Outstanding note saved correctly');
    else log('FAIL', `Outstanding note wrong: ${debtorLift.outstandingNote}`);
  } else {
    log('FAIL', 'Debtor lift not found after addLift()');
  }

  // Check form fields cleared after submit (cleared before save() now, so immediate)
  await page.waitForTimeout(200);
  const amountCleared = await page.evaluate(() => document.getElementById('outstandingAmount').value);
  if (amountCleared === '' || amountCleared === '0') log('PASS', 'Outstanding amount field cleared after add');
  else log('WARN', 'Outstanding amount field not cleared', amountCleared);

  // ═══════════════════════════════════════════════════════
  console.log('\n=== FEATURE 2: Outstanding Amount — Lift Card Display ===');
  // ═══════════════════════════════════════════════════════

  await page.evaluate(() => renderLiftCards());
  await page.waitForTimeout(300);

  const liftCardHTML = await page.$eval('#liftCardsList', el => el.innerHTML);

  // Check OUTSTANDING badge appears for lifts with balance
  if (liftCardHTML.includes('OUTSTANDING')) log('PASS', '💰 OUTSTANDING badge appears in lift cards');
  else log('FAIL', 'OUTSTANDING badge not found in lift cards');

  // Amount is formatted per en-ZA locale: R1 500,00 or R1500 — check for digits that survive encoding
  if (liftCardHTML.includes('500') && liftCardHTML.includes('OUTSTANDING')) log('PASS', 'Outstanding amount visible in lift card');
  else log('FAIL', 'Outstanding amount not visible in lift card');

  if (liftCardHTML.includes('Invoice #789')) log('PASS', 'Outstanding note shown in lift card');
  else log('FAIL', 'Outstanding note not shown in lift card');

  // Check zero-balance lifts show NO outstanding badge
  const zeroBalanceCard = await page.evaluate(() => {
    const idx = lifts.findIndex(l => l.lift === 'ACME-001');
    return idx >= 0 ? document.querySelectorAll('.lift-card-item')[idx]?.innerHTML || '' : '';
  });
  if (!zeroBalanceCard.includes('OUTSTANDING')) log('PASS', 'Zero-balance lifts show no OUTSTANDING badge');
  else log('WARN', 'Zero-balance lift showing OUTSTANDING badge unexpectedly');

  // ═══════════════════════════════════════════════════════
  console.log('\n=== FEATURE 2: Outstanding Amount — CSV Import Column ===');
  // ═══════════════════════════════════════════════════════

  const debtLift = await page.evaluate(() => lifts.find(l => l.lift === 'DEBT-001'));
  if (debtLift) {
    if (debtLift.outstanding === 2500.5) log('PASS', 'CSV outstanding amount R2500.50 saved correctly');
    else log('FAIL', `CSV outstanding amount wrong: ${debtLift.outstanding}`);
    if (debtLift.outstandingNote === 'Invoice #456 overdue 90 days') log('PASS', 'CSV outstanding note saved correctly');
    else log('FAIL', `CSV outstanding note wrong: ${debtLift.outstandingNote}`);
  } else {
    log('FAIL', 'DEBT-001 lift (from CSV) not found');
  }

  // ═══════════════════════════════════════════════════════
  console.log('\n=== FEATURE 2: Outstanding Amount — Edit Lift Modal ===');
  // ═══════════════════════════════════════════════════════

  const debtorIdx = await page.evaluate(() => lifts.findIndex(l => l.lift === 'DEBT-FORM-001'));
  await page.evaluate(i => openEditLiftModal(i), debtorIdx);
  await page.waitForTimeout(300);

  const editAmountVal = await page.$eval('#editOutstandingAmount', el => el.value);
  const editNoteVal = await page.$eval('#editOutstandingNote', el => el.value);

  if (editAmountVal === '1500') log('PASS', 'Edit modal pre-fills outstanding amount');
  else log('FAIL', `Edit modal outstanding amount wrong: "${editAmountVal}"`);

  if (editNoteVal === 'Invoice #789 30 days overdue') log('PASS', 'Edit modal pre-fills outstanding note');
  else log('FAIL', `Edit modal outstanding note wrong: "${editNoteVal}"`);

  // Update the amount
  await page.fill('#editOutstandingAmount', '750');
  await page.fill('#editOutstandingNote', 'Partial payment received');
  await page.evaluate(() => updateLift());
  await page.waitForTimeout(400);

  const updatedLift = await page.evaluate(() => lifts.find(l => l.lift === 'DEBT-FORM-001'));
  if (updatedLift && updatedLift.outstanding === 750) log('PASS', 'Outstanding amount updated via edit modal');
  else log('FAIL', `Updated outstanding wrong: ${updatedLift?.outstanding}`);

  // ═══════════════════════════════════════════════════════
  console.log('\n=== FEATURE 2: Outstanding Amount — Tech Ticket Warning ===');
  // ═══════════════════════════════════════════════════════

  // Create a ticket for a lift with outstanding balance so the tech sees the warning
  await page.evaluate(() => {
    tickets.push({
      ticketNumber: 'TKT-TEST-001',
      lift: lifts.find(l => l.lift === 'DEBT-FORM-001'),
      tech: 'John',
      jobType: 'Service',
      scheduledDate: '2026-06-01',
      note: 'Test service',
      status: 'Open',
      notes: [],
      photos: [],
      created: new Date().toISOString(),
    });
    currentTech = 'John';
  });

  // Render a ticket card and check for the outstanding warning
  const ticketCardHTML = await page.evaluate(() => {
    const t = tickets.find(t => t.ticketNumber === 'TKT-TEST-001');
    const idx = tickets.findIndex(t => t.ticketNumber === 'TKT-TEST-001');
    return renderTicketCard(t, idx);
  });

  if (ticketCardHTML.includes('Outstanding balance') || ticketCardHTML.includes('outstanding')) {
    log('PASS', 'Tech ticket card shows outstanding balance warning');
  } else {
    log('FAIL', 'Tech ticket card missing outstanding balance warning');
  }

  if (ticketCardHTML.includes('750') || ticketCardHTML.includes('750.00')) {
    log('PASS', 'Tech ticket card shows correct updated amount (R750)');
  } else {
    log('FAIL', 'Tech ticket card outstanding amount not shown');
  }

  if (ticketCardHTML.includes('collect payment') || ticketCardHTML.includes('inform')) {
    log('PASS', 'Tech ticket card prompts tech to collect/inform about payment');
  } else {
    log('WARN', 'Tech ticket card missing payment collection prompt');
  }

  // ═══════════════════════════════════════════════════════
  console.log('\n=== JavaScript Errors ===');
  // ═══════════════════════════════════════════════════════
  const ignored = ['net::ERR', 'favicon', 'Failed to fetch', 'ERR_NAME_NOT_RESOLVED',
    'firebase', 'Firebase', 'firestore', 'FIRESTORE', 'Cloud Firestore', 'bad HTTP', 'AbortError'];
  const appErrors = jsErrors.filter(e => !ignored.some(p => e.toLowerCase().includes(p.toLowerCase())));
  if (appErrors.length === 0) log('PASS', 'No JS errors during feature tests');
  else appErrors.forEach(e => log('FAIL', 'JS error', e.substring(0, 150)));

  await browser.close();
  fs.unlinkSync(tmpCsv);

  console.log('\n' + '═'.repeat(55));
  console.log(`  TOTAL: ${passed + failed + warnings} checks`);
  console.log(`  ✅ PASSED:   ${passed}`);
  console.log(`  ❌ FAILED:   ${failed}`);
  console.log(`  ⚠️  WARNINGS: ${warnings}`);
  console.log('═'.repeat(55));
  process.exit(failed > 0 ? 1 : 0);
})();
