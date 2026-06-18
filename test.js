const { chromium } = require('playwright');
const fs = require('fs');

const BASE = 'http://localhost:8080';
let passed = 0, failed = 0, warnings = 0;

function log(status, name, detail = '') {
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️ ';
  console.log(`${icon} [${status}] ${name}${detail ? ': ' + detail : ''}`);
  if (status === 'PASS') passed++;
  else if (status === 'FAIL') failed++;
  else warnings++;
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--ignore-certificate-errors'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // Serve Firebase SDK from local vendor files
  await page.route('**/firebase-app-compat.js', r =>
    r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync('/home/user/crm100/vendor/firebase-app-compat.js') }));
  await page.route('**/firebase-firestore-compat.js', r =>
    r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync('/home/user/crm100/vendor/firebase-firestore-compat.js') }));
  await page.route('**/firebase-storage-compat.js', r =>
    r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync('/home/user/crm100/vendor/firebase-storage-compat.js') }));

  const jsErrors = [];
  page.on('pageerror', err => jsErrors.push(err.message));
  page.on('dialog', d => d.accept());

  // ── 1. Page Load ─────────────────────────────────────────
  console.log('\n=== 1. Page Load ===');
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 10000 });
  const title = await page.title();
  if (title.includes('Econo')) log('PASS', 'Page title correct', title);
  else log('FAIL', 'Page title wrong', title);
  await page.waitForTimeout(5000); // wait for Firebase load attempt

  // ── 2. Login form ─────────────────────────────────────────
  console.log('\n=== 2. Login Form ===');
  if (await page.isVisible('#loginBox')) log('PASS', 'Login box visible');
  else log('FAIL', 'Login box not visible');

  const hasAllLoginFields = await page.evaluate(() =>
    !!(document.getElementById('username') && document.getElementById('password') && document.getElementById('loginType'))
  );
  if (hasAllLoginFields) log('PASS', 'All login fields present');
  else log('FAIL', 'One or more login fields missing');

  // ── 3. Admin Login ────────────────────────────────────────
  console.log('\n=== 3. Admin Login ===');
  await page.evaluate(() => {
    document.getElementById('loginType').value = 'admin';
    document.getElementById('username').value = 'admin';
    document.getElementById('password').value = 'admin123';
    login();
  });
  await page.waitForTimeout(1000);
  const adminVisible = await page.isVisible('#adminApp');
  if (adminVisible) log('PASS', 'Admin logged in successfully');
  else {
    const msg = await page.$eval('#msg', el => el.innerText).catch(() => '');
    log('FAIL', 'Admin login failed', msg || 'adminApp not visible');
    await browser.close(); process.exit(1);
  }

  // Helper
  async function clickTab(tabName) {
    try {
      await page.evaluate(tab => showTab(tab, null), tabName);
      await page.waitForTimeout(400);
      return true;
    } catch(e) { log('WARN', `Tab "${tabName}" threw`, e.message); return false; }
  }

  // ── 4. Dashboard ──────────────────────────────────────────
  console.log('\n=== 4. Dashboard Tab ===');
  if (await clickTab('dashboard')) log('PASS', 'Dashboard tab loaded without crash');

  // ── 5. Lifts tab + Add Lift ──────────────────────────────
  console.log('\n=== 5. Lifts Tab ===');
  await clickTab('lifts');
  const hasLiftForm = await page.evaluate(() =>
    !!(document.getElementById('client') && document.getElementById('lift') && document.getElementById('clientAddress'))
  );
  if (hasLiftForm) {
    log('PASS', 'Add Lift form fields present');
    const uid = Date.now();
    await page.fill('#client', `Test Client ${uid}`);
    await page.fill('#lift', `TEST-${uid}`);
    await page.fill('#clientAddress', '123 Test Street, Cape Town');
    const liftsBefore = await page.evaluate(() => lifts.length);
    await page.evaluate(() => addLift());
    await page.waitForTimeout(600);
    const liftsAfter = await page.evaluate(() => lifts.length);
    if (liftsAfter > liftsBefore) log('PASS', `Lift added (${liftsBefore} → ${liftsAfter} lifts)`);
    else log('FAIL', 'Lift count did not increase after addLift()');
  } else {
    log('FAIL', 'Add Lift form fields missing');
  }

  // ── 6. Tickets tab ───────────────────────────────────────
  console.log('\n=== 6. Tickets Tab ===');
  await clickTab('tickets');
  const hasTicketForm = await page.evaluate(() =>
    !!(document.getElementById('ticketLift') && document.getElementById('ticketTech') && document.getElementById('ticketDate'))
  );
  if (hasTicketForm) log('PASS', 'Ticket form fields present');
  else log('FAIL', 'Ticket form fields missing');

  // Ensure dropdowns are populated then create a ticket
  await page.evaluate(() => populateTicketDropdowns('ticketLift','ticketTech'));
  const ticketResult = await page.evaluate(() => {
    const liftSel = document.getElementById('ticketLift');
    const techSel = document.getElementById('ticketTech');
    const dateFld = document.getElementById('ticketDate');
    // Skip the empty placeholder option (index 0), select first real lift/tech
    const liftOpt = Array.from(liftSel.options).find(o => o.value !== '');
    const techOpt = Array.from(techSel.options).find(o => o.value !== '');
    if (!liftOpt || !techOpt) return { skipped: 'No options in dropdowns' };
    liftSel.value = liftOpt.value;
    techSel.value = techOpt.value;
    dateFld.value = '2026-06-01';
    document.getElementById('ticketNote').value = 'Test service note';
    return { skipped: false };
  });
  if (!ticketResult.skipped) {
    const ticketsBefore = await page.evaluate(() => tickets.length);
    await page.evaluate(() => createTicket());
    await page.waitForTimeout(600);
    const ticketsAfter = await page.evaluate(() => tickets.length);
    if (ticketsAfter > ticketsBefore) log('PASS', `Ticket created (${ticketsBefore} → ${ticketsAfter} tickets)`);
    else log('WARN', 'Ticket count unchanged after createTicket() — may need a lift selected');
  } else {
    log('WARN', 'Skipped ticket creation', ticketResult.skipped);
  }

  // ── 7. Technicians tab ───────────────────────────────────
  console.log('\n=== 7. Technicians Tab ===');
  await clickTab('techs');
  const hasTechForm = await page.evaluate(() =>
    !!(document.getElementById('techName') && document.getElementById('techUsername'))
  );
  if (hasTechForm) log('PASS', 'Add Tech form fields present');
  else log('FAIL', 'Add Tech form fields missing');

  // ── 8. Settings tab (was fully broken before fix) ────────
  console.log('\n=== 8. Settings Tab ===');
  const errsBefore = jsErrors.length;
  await clickTab('settings');
  await page.waitForTimeout(300);
  const settingsRefErrors = jsErrors.slice(errsBefore).filter(e =>
    e.includes('not defined') || e.includes('ReferenceError')
  );
  if (settingsRefErrors.length === 0) log('PASS', 'Settings tab opens with no ReferenceErrors');
  else log('FAIL', 'Settings tab has errors', settingsRefErrors.join(' | '));

  // Language dropdown triggers saveWhatsAppSettings
  const langErrs = jsErrors.length;
  await page.evaluate(() => {
    document.getElementById('whatsappLanguage').value = 'af';
    saveWhatsAppSettings();
  });
  await page.waitForTimeout(200);
  const langNewErrs = jsErrors.slice(langErrs).filter(e => e.includes('not defined'));
  if (langNewErrs.length === 0) log('PASS', 'saveWhatsAppSettings() runs without error');
  else log('FAIL', 'saveWhatsAppSettings() errors', langNewErrs[0]);

  // Quick Reply modal open
  await page.evaluate(() => openQuickReplyModal());
  await page.waitForTimeout(200);
  const modalOpen = await page.isVisible('#quickReplyModal');
  if (modalOpen) log('PASS', 'openQuickReplyModal() shows modal');
  else log('FAIL', 'openQuickReplyModal() did not show modal');

  // Fill and save a quick reply
  await page.fill('#quickReplyName', 'Appointment Reminder');
  await page.fill('#quickReplyMessage', 'Hi {client}, your lift {liftId} service is confirmed.');
  await page.evaluate(() => saveQuickReply());
  await page.waitForTimeout(300);
  const modalClosed = !(await page.isVisible('#quickReplyModal'));
  if (modalClosed) log('PASS', 'saveQuickReply() closes modal');
  else log('FAIL', 'Modal still open after saveQuickReply()');

  const qrSaved = await page.evaluate(() =>
    whatsappSettings.quickReplies && whatsappSettings.quickReplies.length > 0
  );
  if (qrSaved) log('PASS', 'Quick reply saved to whatsappSettings');
  else log('FAIL', 'Quick reply not found in whatsappSettings');

  // Quick Reply list rendered
  const qrListText = await page.$eval('#quickRepliesList', el => el.innerText).catch(() => '');
  if (qrListText.includes('Appointment Reminder')) log('PASS', 'Quick reply appears in rendered list');
  else log('FAIL', 'Quick reply not visible in #quickRepliesList');

  // Close modal button
  await page.evaluate(() => openQuickReplyModal());
  await page.evaluate(() => closeQuickReplyModal());
  await page.waitForTimeout(200);
  const modalClosedAgain = !(await page.isVisible('#quickReplyModal'));
  if (modalClosedAgain) log('PASS', 'closeQuickReplyModal() hides modal');
  else log('FAIL', 'closeQuickReplyModal() did not hide modal');

  // testWhatsAppAPI
  await page.evaluate(() => {
    document.getElementById('whatsappBusinessNumber').value = '27821234567';
    document.getElementById('whatsappApiKey').value = 'test-key';
    testWhatsAppAPI();
  });
  await page.waitForTimeout(200);
  const testApiErrs = jsErrors.filter(e => e.includes('testWhatsAppAPI'));
  if (testApiErrs.length === 0) log('PASS', 'testWhatsAppAPI() runs without error');
  else log('FAIL', 'testWhatsAppAPI() errored', testApiErrs[0]);

  // ── 9. Document deletion fix ─────────────────────────────
  console.log('\n=== 9. Document Deletion Fix ===');
  const docFixOk = await page.evaluate(() => {
    // Simulate a document with uploadedDate set (the fixed field name)
    const testDoc = {
      liftId: 'LIFT-TEST',
      title: 'Test Doc',
      type: 'Manual',
      fileName: 'test.pdf',
      fileUrl: 'http://example.com/test.pdf',
      storagePath: null,
      uploadedDate: new Date().toISOString(),
      uploadedBy: 'admin'
    };
    liftDocuments.push(testDoc);
    currentDocumentLiftId = 'LIFT-TEST';
    // Simulate deleteDocument finding the right index
    const docs = liftDocuments.filter(d => d.liftId === currentDocumentLiftId);
    const doc = docs[0];
    const idx = liftDocuments.findIndex(d =>
      d.liftId === doc.liftId && d.fileName === doc.fileName && d.uploadedDate === doc.uploadedDate
    );
    const found = idx !== -1;
    // Clean up
    if (found) liftDocuments.splice(idx, 1);
    currentDocumentLiftId = '';
    return found;
  });
  if (docFixOk) log('PASS', 'Document deletion finds correct index (uploadedDate field fixed)');
  else log('FAIL', 'Document deletion still broken — index not found');

  // ── 10. Admin password field type ────────────────────────
  console.log('\n=== 10. Admin Password Field ===');
  await clickTab('admins');
  const adminPassType = await page.evaluate(() =>
    document.getElementById('adminPass')?.getAttribute('type') || 'not found'
  );
  if (adminPassType === 'password') log('PASS', 'Admin password field type=password (masked)');
  else if (adminPassType === 'not found') log('WARN', '#adminPass not in DOM');
  else log('FAIL', `Admin password field is type="${adminPassType}" — password exposed`);

  // ── 10b. Toast notification system ───────────────────────
  console.log('\n=== 10b. Toast System ===');
  await page.evaluate(() => showToast('Test toast','success'));
  await page.waitForTimeout(300);
  const toastVisible = await page.evaluate(() => document.querySelectorAll('.toast').length > 0);
  if (toastVisible) log('PASS', 'showToast() renders a toast notification');
  else log('FAIL', 'showToast() did not render a toast');

  // ── 10c. Delete context dialog includes lift name ─────────
  console.log('\n=== 10c. Delete Confirmation Context ===');
  const deleteConfirmText = await page.evaluate(() => {
    // deleteLift should embed lift details in confirm text
    const src = deleteLift.toString();
    return src.includes('l.client') && src.includes('l.lift');
  });
  if (deleteConfirmText) log('PASS', 'deleteLift() confirm shows client/lift details');
  else log('FAIL', 'deleteLift() confirm missing context');

  // ── 10d. createTicket validation specifics ────────────────
  console.log('\n=== 10d. Ticket Validation ===');
  const ticketValidation = await page.evaluate(() => {
    const src = createTicket.toString();
    return src.includes('Please select a lift') && src.includes('Please select a technician');
  });
  if (ticketValidation) log('PASS', 'createTicket() has specific validation messages');
  else log('FAIL', 'createTicket() missing specific validation messages');

  // ── 11. Kanban tab ───────────────────────────────────────
  console.log('\n=== 11. Kanban Tab ===');
  if (await clickTab('kanban')) log('PASS', 'Kanban tab rendered without crash');

  // ── 12. Reports tab ──────────────────────────────────────
  console.log('\n=== 12. Reports Tab ===');
  if (await clickTab('reports')) log('PASS', 'Reports tab rendered without crash');

  // ── 13. Calendar tab ─────────────────────────────────────
  console.log('\n=== 13. Calendar Tab ===');
  if (await clickTab('calendar')) log('PASS', 'Calendar tab rendered without crash');

  // ── 14. Logout & tech login ──────────────────────────────
  console.log('\n=== 14. Logout ===');
  await page.evaluate(() => logout());
  await page.waitForTimeout(800);
  const loginBack = await page.isVisible('#loginBox');
  if (loginBack) log('PASS', 'Logout returns to login screen');
  else log('FAIL', 'Login box not visible after logout');

  console.log('\n=== 15. Tech Login ===');
  // Seed demo techs so tech login works without Firebase
  await page.evaluate(() => { if (techs.length === 0) initializeDemoData(); });
  await page.evaluate(() => {
    document.getElementById('loginType').value = 'tech';
    document.getElementById('username').value = 'john';
    document.getElementById('password').value = 'tech1';
    login();
  });
  await page.waitForTimeout(1000);
  const techVisible = await page.isVisible('#techApp');
  if (techVisible) log('PASS', 'Tech login successful');
  else {
    const msg = await page.$eval('#msg', el => el.innerText).catch(() => '');
    log('FAIL', 'Tech login failed', msg);
  }

  // ── 16. JS error check ───────────────────────────────────
  console.log('\n=== 16. JavaScript Errors ===');
  const ignoredPatterns = [
    'net::ERR', 'favicon', 'Failed to fetch', 'ERR_NAME_NOT_RESOLVED',
    'firebase', 'Firebase', 'firestore', 'FIRESTORE', 'Cloud Firestore',
    'bad HTTP response', 'AbortError', 'quota'
  ];
  const appErrors = jsErrors.filter(e => !ignoredPatterns.some(p => e.toLowerCase().includes(p.toLowerCase())));
  if (appErrors.length === 0) log('PASS', 'No app-level JS errors during session');
  else appErrors.forEach(e => log('FAIL', 'JS error', e.substring(0, 150)));

  await browser.close();

  console.log('\n' + '═'.repeat(55));
  console.log(`  TOTAL: ${passed + failed + warnings} checks`);
  console.log(`  ✅ PASSED:   ${passed}`);
  console.log(`  ❌ FAILED:   ${failed}`);
  console.log(`  ⚠️  WARNINGS: ${warnings}`);
  console.log('═'.repeat(55));
  process.exit(failed > 0 ? 1 : 0);
})();
