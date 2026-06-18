/**
 * Parses the Pastel CustomerListingReport CSV and injects new clients
 * into index.html's initializeDemoData() function, skipping any that
 * already exist (matched by client name, case-insensitive).
 */

const fs = require('fs');

const raw = fs.readFileSync(
  '/root/.claude/uploads/edb4f30b-ebec-5dd0-8d78-704e12b0c8aa/3d74be3a-CustomerListingReport_1.csv',
  'utf8'
);

function parseCsvLine(line) {
  const cols = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inQ) { inQ = true; continue; }
    if (c === '"' && inQ)  { inQ = false; continue; }
    if (c === ',' && !inQ) { cols.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cols.push(cur.trim());
  return cols;
}

const lines = raw.split('\n').map(l => l.replace(/\r$/, ''));

// Customer rows have col[3] === 'Yes' (Active field) — this is the reliable marker
const customers = [];

for (let i = 0; i < lines.length; i++) {
  const cols = parseCsvLine(lines[i]);
  if ((cols[3] || '').trim() !== 'Yes') continue;

  const name         = (cols[0] || '').trim();
  if (!name) continue;

  const tel          = (cols[5] || '').trim();

  // ── Parse address block (lines i+1 up to ~i+8) ──────────────────
  let mobile = '', addr1 = '', addr2 = '', city = '', postalCode = '';

  for (let j = i + 1; j < Math.min(i + 9, lines.length); j++) {
    const ac = parseCsvLine(lines[j]);
    const f0 = (ac[0] || '').trim();
    const f2 = (ac[2] || '').trim();
    const f4 = (ac[4] || '').trim();

    if (f2 === 'Mobile:')           { if (f4) mobile = f4; }  // fall through to capture f0
    if (f2 === 'Email:')            { /* fall through */ }
    if (f2 === 'Credit Limit:')     { continue; }
    if (f2 === 'Default Price List:'|| f4 === 'Default Price List') {
      // postal code is in f0 or ac[1]
      const pc = f0 || (ac[1] || '').trim();
      if (/^\d+$/.test(pc)) postalCode = pc;
      break;
    }
    if (f0 === 'Delivery Address:') { continue; }
    if (f0 === 'Sales Rep:' || f2 === 'Sales Rep:') { continue; }

    // Capture address from f0
    if (!addr1 && f0) addr1 = f0;
    else if (!addr2 && f0 && f0 !== addr1) addr2 = f0;
    else if (!city  && f0 && f0 !== addr2) city  = f0;
  }

  const addrParts = [addr1, addr2, city, postalCode].filter(Boolean);
  const address   = addrParts.join(', ');
  const phone     = tel || mobile;

  customers.push({ name, phone, address });
}

console.log(`Parsed ${customers.length} customers from CSV`);
console.log('Sample:', customers.slice(0, 5).map(c => c.name).join(', '));

// ── Load existing client names from index.html ─────────────────────
const html = fs.readFileSync('/home/user/crm100/index.html', 'utf8');

const existingNames = new Set();
for (const m of html.matchAll(/\{client:"([^"]+)"/g)) {
  existingNames.add(m[1].toLowerCase().trim());
}
console.log(`\nExisting clients in system: ${existingNames.size}`);

// ── Filter to new-only ─────────────────────────────────────────────
const newClients = customers.filter(c => !existingNames.has(c.name.toLowerCase().trim()));
const skipped    = customers.length - newClients.length;
console.log(`New clients to add: ${newClients.length}  (${skipped} already exist)`);

if (newClients.length === 0) {
  console.log('Nothing to add.');
  process.exit(0);
}

// ── Build lift entries ─────────────────────────────────────────────
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const liftEntries = newClients.map((c, idx) => {
  const liftId = `CSV-${String(idx + 1).padStart(3, '0')}`;
  return `    {client:"${esc(c.name)}",address:"${esc(c.address)}",phone:"${esc(c.phone)}",lift:"${liftId}",frequency:6,lastService:Date.now(),isFaulty:false}`;
});

// ── Inject before closing ]; of lifts array ────────────────────────
const LIFTS_END = `    {client:"C.F. --Chris & Ina- Heyens",address:"32 Buitekant Street STILBAY",phone:"028 754 2336",lift:"EHL-L2/05",frequency:6,lastService:Date.now(),isFaulty:false}\n  ];`;

if (!html.includes(LIFTS_END)) {
  console.error('ERROR: Cannot find end-of-lifts marker in index.html');
  process.exit(1);
}

const newHtml = html.replace(
  LIFTS_END,
  LIFTS_END.replace('\n  ];', ',\n' + liftEntries.join(',\n') + '\n  ];')
);

fs.writeFileSync('/home/user/crm100/index.html', newHtml);
console.log(`\n✅ Done! Added ${newClients.length} new clients.`);
console.log('\nFirst 15 new clients:');
newClients.slice(0, 15).forEach((c, i) =>
  console.log(`  ${i+1}. ${c.name} | ${c.phone || 'no phone'} | ${c.address}`)
);
if (skipped > 0) {
  console.log(`\nSkipped (already exist): ${skipped}`);
}
