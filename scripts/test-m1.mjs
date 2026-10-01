// M1 acceptance checks (permissions + notification). Usage: node --env-file=.env scripts/test-m1.mjs
const BASE = (process.env.BASE_URL ?? 'http://localhost:8080') + '/api/v1/';
const auth = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const call = async (who, method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { Authorization: who, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); return { s: r.status, j: t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : t };
};
const admin = auth('admin', process.env.ESPOCRM_ADMIN_PASSWORD);
const e1 = auth('emp1', process.env.EMPLOYEE_PASSWORD), e2 = auth('emp2', process.env.EMPLOYEE_PASSWORD);
let fails = 0;
const ok = (name, cond, extra = '') => { console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : extra); if (!cond) fails++; };

const users = (await call(admin, 'GET', 'User?where[0][type]=startsWith&where[0][attribute]=userName&where[0][value]=emp')).j.list;
const id = n => users.find(u => u.userName === n).id;
const stamp = Date.now();
const t1 = (await call(admin, 'POST', 'Task', { name: `T1 ${stamp}`, assignedUserId: id('emp1'), priority: 'High', dateEnd: '2026-01-01 00:00:00' })).j;
const t2 = (await call(admin, 'POST', 'Task', { name: `T2 ${stamp}`, assignedUserId: id('emp2') })).j;

const list1 = (await call(e1, 'GET', 'Task?maxSize=100')).j.list.map(t => t.id);
ok('emp1 sees own task', list1.includes(t1.id));
ok("emp1 does not see emp2's task in list", !list1.includes(t2.id));
ok("emp1 GET emp2's task forbidden", (await call(e1, 'GET', `Task/${t2.id}`)).s === 403);
ok('emp1 sees only own team', (await call(e1, 'GET', 'Team')).j.list?.length === 1);
for (const p of ['Role', 'Import', 'Campaign', 'Extension', 'Settings/../Admin/jobs']) {
  const s = (await call(e1, 'GET', p)).s; ok(`emp1 blocked from ${p}`, s === 403 || s === 404, s);
}
ok('emp1 can set status Started', (await call(e1, 'PUT', `Task/${t1.id}`, { status: 'Started' })).s === 200);
ok('emp1 can set status Completed + dateCompleted stored', await (async () => {
  await call(e1, 'PUT', `Task/${t1.id}`, { status: 'Completed' });
  return !!(await call(admin, 'GET', `Task/${t1.id}`)).j.dateCompleted;
})());
await call(e1, 'PUT', `Task/${t1.id}`, { name: 'hacked', assignedUserId: id('emp2'), priority: 'Low' });
const after = (await call(admin, 'GET', `Task/${t1.id}`)).j;
ok('emp1 cannot rename/reassign/reprioritise task (ignored or rejected)', after.name === `T1 ${stamp}` && after.assignedUserId === id('emp1') && after.priority === 'High', JSON.stringify([after.name, after.assignedUserId, after.priority]));
ok('emp1 sees only own user record', (await call(e1, 'GET', 'User?maxSize=50')).j.list?.every(u => u.userName === 'emp1'));
ok('emp1 cannot delete task', (await call(e1, 'DELETE', `Task/${t1.id}`)).s === 403);
ok('emp1 cannot create task', (await call(e1, 'POST', 'Task', { name: 'x' })).s === 403);
ok('emp1 can comment (stream note)', (await call(e1, 'POST', 'Note', { type: 'Post', post: 'done', parentType: 'Task', parentId: t1.id })).s === 200);
const n = (await call(e2, 'GET', 'Notification?maxSize=20')).j.list ?? [];
ok('emp2 got assignment notification', n.some(x => JSON.stringify(x).includes(t2.id)), JSON.stringify(n).slice(0, 200));
const ts = (await call(admin, 'GET', 'Task?maxSize=100')).j.list.map(t => t.id);
ok('owner sees all tasks', ts.includes(t1.id) && ts.includes(t2.id));
const dash = (await call(e1, 'GET', 'Preferences/' + id('emp1'))).j;
ok('emp1 dashboard locked + deployed', dash.dashboardLocked === true && dash.dashboardLayout?.[0]?.layout?.length > 0, JSON.stringify(dash.dashboardLocked));
for (const t of [t1, t2]) await call(admin, 'DELETE', `Task/${t.id}`);
console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
