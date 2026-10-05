// Import leads from a CSV into EspoCRM (Leads + a Target List) using EspoCRM's Import tool, with a fixed column mapping.
// Usage: node --env-file=.env scripts/import-leads.mjs samples/leads-template.csv "My target list"
// The same import can be repeated in the UI: Import > open a finished import > "New import with same params".
// Expected header: email,first_name,last_name,company,industry,city,interest,notes  (see samples/leads-template.csv)
import { readFileSync } from 'node:fs';
import http from 'node:http';

export const MAPPING = {
  email: 'emailAddress', first_name: 'firstName', last_name: 'lastName', company: 'accountName',
  industry: 'industryText', city: 'addressCity', interest: 'interestTopic', notes: 'description',
};

export async function importLeads(csv, listName, { base = process.env.BASE_URL ?? `http://localhost:${process.env.ESPO_PORT ?? 8080}`, password = process.env.ESPOCRM_ADMIN_PASSWORD, assignedUserId, removeDuplicates = true } = {}) {
  const headers = { Authorization: 'Basic ' + Buffer.from(`admin:${password}`).toString('base64') };
  // node:http instead of fetch: a big import runs for minutes inside one request, and fetch gives up after 5 minutes.
  const call = (method, path, body, type = 'application/json') => new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/v1/${path}`, { method, headers: { ...headers, 'Content-Type': type, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }, timeout: 0 }, res => {
      let t = '';
      res.on('data', d => (t += d));
      res.on('end', () => (res.statusCode < 400 ? resolve(JSON.parse(t)) : reject(new Error(`${method} ${path} -> ${res.statusCode} ${res.headers['x-status-reason'] ?? ''} ${t.slice(0, 300)}`))));
    });
    req.on('error', reject);
    req.end(body);
  });
  const header = csv.split(/\r?\n/, 1)[0].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
  const unknown = header.filter(h => !(h in MAPPING));
  if (!header.includes('email')) throw new Error('The CSV needs an "email" column.');

  const q = new URLSearchParams({ 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': listName, maxSize: '1' });
  const list = (await call('GET', `TargetList?${q}`)).list[0] ?? (await call('POST', 'TargetList', JSON.stringify({ name: listName })));

  const { attachmentId } = await call('POST', 'Import/file', csv, 'text/csv');
  const result = await call('POST', 'Import', JSON.stringify({
    entityType: 'Lead', attachmentId, headerRow: true, action: 'create', delimiter: ',', textQualifier: '"',
    personNameFormat: 'f l', skipDuplicateChecking: false, idleMode: false, silentMode: false,
    attributeList: header.map(h => MAPPING[h] ?? null),
    defaultValues: { targetListId: list.id, targetListName: listName, ...(assignedUserId ? { assignedUserId } : {}) },
  }));
  const errors = (await call('GET', `Import/${result.id}/errors?maxSize=200`)).list ?? [];
  // EspoCRM imports rows whose email already exists but marks them as duplicates. A duplicate lead would get a second proposal, so they are removed.
  const duplicates = (await call('GET', `Import/${result.id}/duplicates?select=id&maxSize=1`)).total;
  if (removeDuplicates && duplicates) await call('POST', `Import/${result.id}/removeDuplicates`, '{}');
  return {
    importId: result.id, targetListId: list.id, created: result.countCreated - (removeDuplicates ? duplicates : 0), duplicates, duplicatesRemoved: removeDuplicates,
    failed: errors.length, ignoredColumns: unknown, errors: errors.map(e => ({ row: e.rowIndex, type: e.type, fields: e.validationFailures ?? e.exportRow })),
  };
}

if (import.meta.main) {
  const [file, listName] = process.argv.slice(2);
  if (!file || !listName) { console.error('Usage: import-leads.mjs <file.csv> "<target list name>"'); process.exit(1); }
  const r = await importLeads(readFileSync(file, 'utf8'), listName);
  console.log(`Created ${r.created}, duplicates skipped ${r.duplicates}, invalid rows ${r.failed}. Target list: ${listName}`);
  if (r.ignoredColumns.length) console.log('Ignored columns:', r.ignoredColumns.join(', '));
  for (const e of r.errors) console.log(`  row ${e.row}: ${e.type} ${JSON.stringify(e.fields)}`);
  console.log(`Undo in one click: Import > ${r.importId} > Revert.`);
}
