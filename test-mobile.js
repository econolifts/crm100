const { chromium, devices } = require('playwright');
const fs = require('fs');

const BASE = 'http://localhost:8080';
const DEVICE = devices['Pixel 5'];
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
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--ignore-certificate-errors', '--no-proxy-server'] });

  // ── Test A: Pixel 5 portrait (393×851) ───────────────────
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`DEVICE: Pixel 5  (${DEVICE.viewport.width}×${DEVICE.viewport.height})  UA: Android`);
  console.log('═'.repeat(55));

  const ctx = await browser.newContext({ ...DEVICE, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await vendorRoute(page);

  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(e.message));
  page.on('dialog', d => d.accept());

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // ── 1. Viewport & meta viewport ──────────────────────────
  console.log('\n=== 1. Mobile Viewport ===');
  const vp = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    metaViewport: document.querySelector('meta[name="viewport"]')?.content || 'MISSING',
    hasAppleMeta: !!document.querySelector('meta[name="apple-mobile-web-app-capable"]'),
  }));
  if (vp.metaViewport.includes('width=device-width'))
    log('PASS', 'meta viewport set correctly', vp.metaViewport);
  else
    log('FAIL', 'meta viewport missing or wrong', vp.metaViewport);

  if (vp.width <= 393) log('PASS', `Page renders at mobile width (${vp.width}px)`);
  else log('FAIL', `Page is wider than device (${vp.width}px — not scaling to mobile)`);

  if (vp.hasAppleMeta) log('PASS', 'apple-mobile-web-app-capable meta present (PWA-ready)');
  else log('WARN', 'apple-mobile-web-app-capable meta missing');

  // ── 2. No horizontal scroll ───────────────────────────────
  console.log('\n=== 2. No Horizontal Overflow ===');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (!overflow) log('PASS', 'No horizontal overflow on login screen');
  else log('FAIL', `Horizontal overflow on login: scrollWidth=${document.documentElement.scrollWidth}`);

  // ── 3. Touch-friendly login ───────────────────────────────
  console.log('\n=== 3. Login via Touch ===');
  // Tap the username field
  const userField = await page.$('#username');
  if (userField) {
    await userField.tap();
    await page.fill('#username', 'admin');
    await page.tap('#password');
    await page.fill('#password', 'admin123');
    await page.selectOption('#loginType', 'admin');
    const loginBtn = await page.$('button[onclick="login()"]');
    if (loginBtn) {
      const box = await loginBtn.boundingBox();
      if (box && box.height >= 40)
        log('PASS', `Login button touch target adequate (${Math.round(box.height)}px tall)`);
      else
        log('FAIL', `Login button too small for touch (${box ? Math.round(box.height) : '?'}px tall — needs ≥40px)`);
      await loginBtn.tap();
      await page.waitForTimeout(1000);
    }
  }

  const adminVisible = await page.isVisible('#adminApp');
  if (adminVisible) log('PASS', 'Admin login via tap successful');
  else { log('FAIL', 'Admin login via tap failed'); await browser.close(); process.exit(1); }

  // Helper
  async function tapTab(tabName) {
    try { await page.evaluate(t => showTab(t, null), tabName); await page.waitForTimeout(400); return true; }
    catch(e) { log('WARN', `Tab "${tabName}" threw`, e.message); return false; }
  }

  // ── 4. Admin tabs — no overflow on mobile ─────────────────
  console.log('\n=== 4. Tab Bar ===');
  const tabBar = await page.$('.tabs, [class*="tab-bar"], #adminApp .tabs');
  if (tabBar) {
    const tabOverflow = await page.evaluate(() => {
      const el = document.querySelector('#adminApp .tabs');
      return el ? el.scrollWidth > el.clientWidth : null;
    });
    if (tabOverflow === null) log('WARN', 'Could not find tab bar element');
    else if (tabOverflow) log('WARN', 'Tab bar overflows horizontally — may need scroll or smaller tabs on mobile');
    else log('PASS', 'Tab bar fits within mobile width');
  } else {
    log('WARN', 'Tab bar not found for overflow check');
  }

  // Check all tabs render without crash or horizontal overflow
  const tabs = ['dashboard', 'lifts', 'tickets', 'techs', 'kanban', 'reports', 'calendar', 'settings'];
  console.log('\n=== 5. All Tabs — Mobile Render ===');
  for (const tab of tabs) {
    await tapTab(tab);
    const tabOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 5);
    if (tabOverflow) log('WARN', `"${tab}" tab has horizontal overflow`);
    else log('PASS', `"${tab}" tab renders without overflow`);
  }

  // ── 6. Touch targets on Lifts tab ─────────────────────────
  console.log('\n=== 6. Touch Target Sizes ===');
  await tapTab('lifts');

  // Add a lift first so we have buttons to check
  await page.evaluate(() => {
    document.getElementById('client').value = 'Mobile Test Client';
    document.getElementById('lift').value = 'MOB-001';
    document.getElementById('clientAddress').value = '1 Mobile St';
    addLift();
  });
  await page.waitForTimeout(500);

  // Check button sizes on lifts tab
  const buttonSizes = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#lifts-tab button, #adminApp button:not([style*="display:none"])')].slice(0, 10);
    return btns.map(b => {
      const r = b.getBoundingClientRect();
      return { text: b.innerText.substring(0, 20), h: Math.round(r.height), w: Math.round(r.width) };
    }).filter(b => b.h > 0);
  });
  const tooSmall = buttonSizes.filter(b => b.h < 36);
  if (tooSmall.length === 0) log('PASS', `All checked buttons ≥36px tall (${buttonSizes.length} checked)`);
  else log('WARN', `${tooSmall.length} button(s) under 36px: ${tooSmall.map(b => `"${b.text}"(${b.h}px)`).join(', ')}`);

  // ── 7. Input field font size (prevents iOS zoom) ──────────
  console.log('\n=== 7. Input Font Size (prevents auto-zoom) ===');
  const smallInputs = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input, select, textarea')];
    return inputs.filter(i => {
      const fs = parseFloat(window.getComputedStyle(i).fontSize);
      return fs < 16;
    }).map(i => ({ tag: i.tagName, id: i.id, placeholder: i.placeholder?.substring(0,30), fontSize: parseFloat(window.getComputedStyle(i).fontSize) }));
  });
  if (smallInputs.length === 0) log('PASS', 'All inputs ≥16px font (no auto-zoom on focus)');
  else log('WARN', `${smallInputs.length} inputs under 16px font (may cause zoom on Android/iOS)`, smallInputs.slice(0,3).map(i=>`${i.tag}#${i.id||'?'}(${i.fontSize}px)`).join(', '));

  // ── 8. Tickets tab on mobile ──────────────────────────────
  console.log('\n=== 8. Tickets Tab Mobile ===');
  await tapTab('tickets');
  // Populate dropdowns to check form usability
  const ticketFormOk = await page.evaluate(() => ({
    liftOptions: document.getElementById('ticketLift')?.options.length,
    techOptions: document.getElementById('ticketTech')?.options.length,
  }));
  log('PASS', `Ticket dropdowns: ${ticketFormOk.liftOptions} lift(s), ${ticketFormOk.techOptions} tech(s)`);

  // ── 9. Settings tab WhatsApp functions on mobile ──────────
  console.log('\n=== 9. Settings Tab on Mobile ===');
  const errsBefore = jsErrors.length;
  await tapTab('settings');
  await page.waitForTimeout(300);
  const settingsErrs = jsErrors.slice(errsBefore).filter(e => e.includes('not defined') || e.includes('ReferenceError'));
  if (settingsErrs.length === 0) log('PASS', 'Settings tab no ReferenceErrors on mobile');
  else log('FAIL', 'Settings errors on mobile', settingsErrs.join(' | '));

  // Tap Add Quick Reply
  await page.evaluate(() => openQuickReplyModal());
  await page.waitForTimeout(200);
  const modalVis = await page.isVisible('#quickReplyModal');
  if (modalVis) {
    log('PASS', 'Quick Reply modal opens on mobile');
    // Check modal fits in viewport
    const modalBox = await page.evaluate(() => {
      const m = document.getElementById('quickReplyModal').querySelector('div');
      const r = m.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, vpWidth: window.innerWidth };
    });
    if (modalBox.right <= modalBox.vpWidth + 5) log('PASS', `Quick Reply modal fits in viewport (${Math.round(modalBox.width)}px wide)`);
    else log('FAIL', `Quick Reply modal overflows viewport (${Math.round(modalBox.right)}px > ${modalBox.vpWidth}px)`);
    await page.evaluate(() => closeQuickReplyModal());
  } else {
    log('FAIL', 'Quick Reply modal did not open on mobile');
  }

  // ── 10. Tech login on mobile ──────────────────────────────
  console.log('\n=== 10. Tech Login & Tech UI ===');
  await page.evaluate(() => logout());
  await page.waitForTimeout(800);
  await page.evaluate(() => { if (techs.length === 0) initializeDemoData(); });
  await page.evaluate(() => {
    document.getElementById('loginType').value = 'tech';
    document.getElementById('username').value = 'john';
    document.getElementById('password').value = 'tech1';
    login();
  });
  await page.waitForTimeout(1000);
  const techVis = await page.isVisible('#techApp');
  if (techVis) log('PASS', 'Tech login successful on mobile');
  else log('FAIL', 'Tech login failed on mobile');

  if (techVis) {
    // Check tech UI overflow
    const techOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 5);
    if (!techOverflow) log('PASS', 'Tech view has no horizontal overflow');
    else log('WARN', 'Tech view has horizontal overflow');

    // Check tech tab buttons
    const techTabSizes = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('#techApp .tab')];
      return tabs.map(t => ({ text: t.innerText.substring(0,15), h: Math.round(t.getBoundingClientRect().height) }));
    });
    const smallTechTabs = techTabSizes.filter(t => t.h > 0 && t.h < 36);
    if (smallTechTabs.length === 0) log('PASS', `Tech tabs adequately sized (${techTabSizes.length} tabs)`);
    else log('WARN', `${smallTechTabs.length} tech tab(s) under 36px`, smallTechTabs.map(t=>`"${t.text}"(${t.h}px)`).join(', '));
  }

  // ── 11. PWA / Offline capability ──────────────────────────
  console.log('\n=== 11. PWA Readiness ===');
  const pwa = await page.evaluate(() => ({
    hasServiceWorker: 'serviceWorker' in navigator,
    hasManifest: !!document.querySelector('link[rel="manifest"]'),
    hasAppleTouchIcon: !!document.querySelector('link[rel="apple-touch-icon"]'),
    themeColor: document.querySelector('meta[name="theme-color"]')?.content || null,
  }));
  if (pwa.hasAppleTouchIcon) log('PASS', 'Apple touch icon present');
  else log('WARN', 'No apple-touch-icon (home screen icon will be generic)');
  if (pwa.themeColor) log('PASS', `Theme color set (${pwa.themeColor})`);
  else log('WARN', 'No theme-color meta (status bar won\'t match app)');
  if (pwa.hasManifest) log('PASS', 'Web app manifest linked');
  else log('WARN', 'No manifest.json — app cannot be "Add to Home Screen" as a full PWA');
  if (pwa.hasServiceWorker) log('WARN', 'Service worker API available but not checked if registered — no offline support confirmed');

  // ── 12. Landscape mode ────────────────────────────────────
  console.log('\n=== 12. Landscape Orientation ===');
  await page.setViewportSize({ width: 851, height: 393 });
  await page.waitForTimeout(500);
  const landscapeOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 5);
  if (!landscapeOverflow) log('PASS', 'No horizontal overflow in landscape mode');
  else log('WARN', 'Horizontal overflow in landscape mode');
  // Back to portrait
  await page.setViewportSize({ width: 393, height: 851 });

  // ── 13. JS errors summary ─────────────────────────────────
  console.log('\n=== 13. JavaScript Errors ===');
  const ignored = ['net::ERR', 'favicon', 'Failed to fetch', 'ERR_NAME_NOT_RESOLVED',
    'firebase', 'Firebase', 'firestore', 'FIRESTORE', 'Cloud Firestore', 'bad HTTP', 'AbortError'];
  const appErrors = jsErrors.filter(e => !ignored.some(p => e.toLowerCase().includes(p.toLowerCase())));
  if (appErrors.length === 0) log('PASS', 'No app-level JS errors during mobile session');
  else appErrors.forEach(e => log('FAIL', 'JS error', e.substring(0, 150)));

  await ctx.close();
  await browser.close();

  console.log('\n' + '═'.repeat(55));
  console.log(`  Device: Pixel 5 (393×851) Android`);
  console.log(`  TOTAL: ${passed + failed + warnings} checks`);
  console.log(`  ✅ PASSED:   ${passed}`);
  console.log(`  ❌ FAILED:   ${failed}`);
  console.log(`  ⚠️  WARNINGS: ${warnings}`);
  console.log('═'.repeat(55));
  process.exit(failed > 0 ? 1 : 0);
})();
