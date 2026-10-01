// Adds a real employee: user account (role Employee, team Staff), locked Employee dashboard. Prints a one-time temporary password.
// Usage on the server: sh scripts/deploy.sh add-employee <userName> "<First name>" "<Last name>" <email>
// Locally:             node --env-file=.env scripts/add-employee.mjs <userName> "<First name>" "<Last name>" <email>
import { randomBytes } from 'node:crypto';

const [userName, firstName, lastName, emailAddress] = process.argv.slice(2);
if (!userName || !firstName || !lastName || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailAddress ?? '')) {
  console.error('Usage: add-employee.mjs <userName> "<First name>" "<Last name>" <email>');
  process.exit(1);
}
const BASE = (process.env.BASE_URL ?? 'http://localhost:8080') + '/api/v1/';
const AUTH = 'Basic ' + Buffer.from(`admin:${process.env.ESPOCRM_ADMIN_PASSWORD}`).toString('base64');
async function api(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { Authorization: AUTH, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${r.headers.get('x-status-reason') ?? ''} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const find = async (entity, attribute, value) =>
  (await api('GET', `${entity}?${new URLSearchParams({ 'where[0][type]': 'equals', 'where[0][attribute]': attribute, 'where[0][value]': value, maxSize: '1' })}`)).list?.[0];

const [role, team, tpl] = await Promise.all([find('Role', 'name', 'Employee'), find('Team', 'name', 'Staff'), find('DashboardTemplate', 'name', 'Employee')]);
if (!role || !team || !tpl) throw new Error('Run the setup scripts first (role Employee, team Staff, dashboard template Employee are missing).');
if (await find('User', 'userName', userName)) throw new Error(`User "${userName}" already exists.`);

// 14 characters: letters of both cases, digits and a dash, so it passes the password policy
const pick = (chars, n) => Array.from(randomBytes(n), b => chars[b % chars.length]).join('');
const password = `${pick('ABCDEFGHJKLMNPQRSTUVWXYZ', 4)}-${pick('abcdefghijkmnpqrstuvwxyz', 6)}${pick('23456789', 3)}`;

const user = await api('POST', 'User', {
  userName, firstName, lastName, emailAddress, type: 'regular', password, passwordConfirm: password,
  teamsIds: [team.id], defaultTeamId: team.id, rolesIds: [role.id],
});
await api('POST', 'DashboardTemplate/action/deployToUsers', { id: tpl.id, userIdList: [user.id] });
await api('PUT', `Preferences/${user.id}`, { dashboardLocked: true });
console.log(`Created ${firstName} ${lastName} (${userName}).`);
console.log(`Temporary password (shown once): ${password}`);
console.log('Give it to them privately and ask them to change it at first login (top right menu > Preferences).');
