// M2 acceptance checks. Usage: node --env-file=.env scripts/test-m2.mjs  (needs docker compose env for the job test)
import { execSync } from 'node:child_process';
const BASE = (process.env.BASE_URL ?? `http://localhost:${process.env.ESPO_PORT ?? 8080}`) + '/api/v1/';
const auth = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const call = async (who, method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { Authorization: who, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); return { s: r.status, j: t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : t };
};
const admin = auth('admin', process.env.ESPOCRM_ADMIN_PASSWORD);
const e1 = auth('emp1', process.env.EMPLOYEE_PASSWORD), e2 = auth('emp2', process.env.EMPLOYEE_PASSWORD);
let fails = 0;
const ok = (name, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : extra); if (!cond) fails++; };
const fmt = d => d.toISOString().slice(0, 19).replace('T', ' ');
const setCfg = cfg => call(admin, 'PUT', 'Settings', cfg);
const made = [];
const cleanup = async () => {
  for (const u of ['emp1', 'emp2']) { const a = u === 'emp1' ? e1 : e2; await call(a, 'POST', 'Attendance/action/checkOut'); }
  for (const id of made) await call(admin, 'DELETE', `Attendance/${id}`);
  const all = (await call(admin, 'GET', 'Attendance?maxSize=200')).j.list ?? [];
  for (const a of all) await call(admin, 'DELETE', `Attendance/${a.id}`);
  await setCfg({ attendanceAllowedIps: '', attendanceOfficeStart: '09:00' });
};
await cleanup();
const users = (await call(admin, 'GET', 'User?where[0][type]=startsWith&where[0][attribute]=userName&where[0][value]=emp')).j.list;
const id = n => users.find(u => u.userName === n).id;

// basic flow
const a1 = await call(e1, 'POST', 'Attendance/action/checkIn');
ok('emp1 check-in works', a1.s === 200 && a1.j.checkIn && a1.j.ipAddress, JSON.stringify(a1));
ok('emp1 double check-in rejected', (await call(e1, 'POST', 'Attendance/action/checkIn')).s === 409);
ok('status shows open', (await call(e1, 'GET', 'Attendance/action/status')).j.open === true);
const out = await call(e1, 'POST', 'Attendance/action/checkOut');
ok('emp1 check-out works and hours calculated', out.s === 200 && out.j.checkOut && out.j.hours === 0, JSON.stringify(out));
ok('check-out when not checked in rejected', (await call(e1, 'POST', 'Attendance/action/checkOut')).s === 409);

// parallel taps => exactly one open shift
const par = await Promise.all(Array.from({ length: 6 }, () => call(e2, 'POST', 'Attendance/action/checkIn')));
ok('6 parallel check-ins => exactly one succeeds', par.filter(r => r.s === 200).length === 1, par.map(r => r.s).join(','));
await call(e2, 'POST', 'Attendance/action/checkOut');

// hours = checkOut - checkIn (positive), owner correction + audit
const now = Date.now();
const sh = (await call(admin, 'POST', 'Attendance', { assignedUserId: id('emp1'), checkIn: fmt(new Date(now - 9.5 * 3600e3)), checkOut: fmt(new Date(now - 1 * 3600e3)) })).j; made.push(sh.id);
ok('formula: hours = 8.5 for 8h30 shift', sh.hours === 8.5, JSON.stringify(sh.hours));
const fixed = (await call(admin, 'PUT', `Attendance/${sh.id}`, { checkOut: fmt(new Date(now - 2 * 3600e3)) })).j;
ok('owner correction recalculates hours (7.5)', fixed.hours === 7.5, String(fixed.hours));
const stream = (await call(admin, 'GET', `Attendance/${sh.id}/stream`)).j;
ok('correction is in the audit stream', JSON.stringify(stream).includes('checkOut'), JSON.stringify(stream).slice(0, 200));

// access control
ok('employee cannot create attendance via CRUD', (await call(e1, 'POST', 'Attendance', { assignedUserId: id('emp1'), checkIn: fmt(new Date()) })).s === 403);
ok('employee cannot edit attendance', (await call(e1, 'PUT', `Attendance/${sh.id}`, { checkOut: fmt(new Date()) })).s === 403);
ok('employee cannot delete attendance', (await call(e1, 'DELETE', `Attendance/${sh.id}`)).s === 403);
ok('employee sees only own records', (await call(e2, 'GET', 'Attendance?maxSize=100')).j.list.every(a => a.assignedUserId === id('emp2')));
ok('employee cannot read monthly summary', (await call(e1, 'GET', 'Attendance/action/monthlySummary')).s === 403);
const ms = (await call(admin, 'GET', 'Attendance/action/monthlySummary')).j;
ok('owner monthly summary matches records', ms.list.some(r => r.userId === id('emp1') && r.hours >= 7.5), JSON.stringify(ms));

// IP allow-list
await setCfg({ attendanceAllowedIps: '203.0.113.9' });
ok('check-in blocked outside allowed IP', (await call(e1, 'POST', 'Attendance/action/checkIn')).s === 403);
await setCfg({ attendanceAllowedIps: '' });

// late flag from configurable start time
await setCfg({ attendanceOfficeStart: '23:59' });
const early = await call(e1, 'POST', 'Attendance/action/checkIn'); await call(e1, 'POST', 'Attendance/action/checkOut');
ok('not late before office start', early.j.isLate === false, JSON.stringify(early.j.isLate));
await setCfg({ attendanceOfficeStart: '00:00' });
const late = await call(e1, 'POST', 'Attendance/action/checkIn');
ok('late after office start', late.j.isLate === true);

// filters: open / late / today
const f = async n => (await call(admin, 'GET', `Attendance?primaryFilter=${n}&maxSize=100`)).j.list ?? [];
ok('filter open lists emp1 checked in now', (await f('open')).some(a => a.id === late.j.id));
ok('filter late lists the late shift', (await f('late')).some(a => a.id === late.j.id));
ok('filter today lists today shifts', (await f('today')).some(a => a.id === late.j.id));
await call(e1, 'POST', 'Attendance/action/checkOut');

// nightly auto-close
const stale = (await call(admin, 'POST', 'Attendance', { assignedUserId: id('emp2'), checkIn: fmt(new Date(now - 26 * 3600e3)) })).j; made.push(stale.id);
execSync('docker compose exec -T -u www-data espocrm php command.php run-job AutoCloseAttendance', { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: 'pipe' });
const closed = (await call(admin, 'GET', `Attendance/${stale.id}`)).j;
ok('forgotten shift auto-closed + flagged', closed.autoClosed === true && closed.checkOut?.endsWith('23:59:59') && closed.hours > 0, JSON.stringify([closed.checkOut, closed.autoClosed, closed.hours]));

await cleanup();
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
