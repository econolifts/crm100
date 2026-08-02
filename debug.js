const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:8080';

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--ignore-certificate-errors'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // Intercept Firebase + Chart.js CDN requests and serve locally
  await page.route('**/firebase-app-compat.js', route =>
    route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync('/home/user/crm100/vendor/firebase-app-compat.js') }));
  await page.route('**/firebase-firestore-compat.js', route =>
    route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync('/home/user/crm100/vendor/firebase-firestore-compat.js') }));
  await page.route('**/firebase-storage-compat.js', route =>
    route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync('/home/user/crm100/vendor/firebase-storage-compat.js') }));

  page.on('dialog', d => { console.log('DIALOG:', d.message().substring(0,120)); d.accept(); });
  page.on('console', msg => { if (msg.type() !== 'log') console.log(`CONSOLE [${msg.type()}]:`, msg.text().substring(0,120)); });
  page.on('pageerror', err => console.log('PAGEERROR:', err.message.substring(0,120)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  console.log('Page loaded, waiting 6s for Firebase...');
  await page.waitForTimeout(6000);

  const state = await page.evaluate(() => ({
    adminsCount: typeof admins !== 'undefined' ? admins.length : 'undefined',
    firebaseDefined: typeof firebase !== 'undefined',
    loginBoxVisible: document.getElementById('loginBox')?.offsetParent !== null,
    loginDefined: typeof login !== 'undefined',
  }));
  console.log('State before login:', JSON.stringify(state, null, 2));

  if (!state.loginDefined) {
    console.log('login() not defined - scripts failed to execute. Check PAGEERROR above.');
    await browser.close();
    return;
  }

  const loginResult = await page.evaluate(async () => {
    document.getElementById('loginType').value = 'admin';
    document.getElementById('username').value = 'admin';
    document.getElementById('password').value = 'admin123';
    login();
    await new Promise(r => setTimeout(r, 800));
    return {
      adminVisible: document.getElementById('adminApp')?.style.display !== 'none' && document.getElementById('adminApp')?.style.display !== '',
      msg: document.getElementById('msg')?.innerText,
      currentAdmin: typeof currentAdmin !== 'undefined' ? currentAdmin : 'undefined',
    };
  });
  console.log('Login result:', JSON.stringify(loginResult, null, 2));

  await browser.close();
})();
