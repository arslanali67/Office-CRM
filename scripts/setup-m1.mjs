// M1 setup via EspoCRM REST API. Idempotent: safe to re-run.
// Usage: node --env-file=.env scripts/setup-m1.mjs   (BASE_URL defaults to http://localhost:8080)
const BASE = (process.env.BASE_URL ?? `http://localhost:${process.env.ESPO_PORT ?? 8080}`) + '/api/v1/';
const AUTH = 'Basic ' + Buffer.from(`admin:${process.env.ESPOCRM_ADMIN_PASSWORD}`).toString('base64');

async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${r.headers.get('x-status-reason') ?? ''} ${text}`);
  return text ? JSON.parse(text) : null;
}
const find = async (entity, where) =>
  (await api('GET', `${entity}?${new URLSearchParams(where)}&maxSize=1`)).list?.[0];
async function upsert(entity, name, data, nameField = 'name') {
  const ex = await find(entity, { [`where[0][type]`]: 'equals', [`where[0][attribute]`]: nameField, [`where[0][value]`]: name });
  return ex ? api('PUT', `${entity}/${ex.id}`, data) : api('POST', entity, data);
}

// ---- Roles ----
const employeeData = {
  Task: { create: 'no', read: 'own', edit: 'own', delete: 'no', stream: 'own' },
  Lead: { create: 'no', read: 'own', edit: 'own', delete: 'no', stream: 'own' },
  Email: { create: 'yes', read: 'own', edit: 'own', delete: 'no' },
  KnowledgeBaseArticle: { create: 'no', read: 'all', edit: 'no', delete: 'no' },
  Attendance: { create: 'no', read: 'own', edit: 'no', delete: 'no', stream: 'own' },
  User: { create: 'no', read: 'own', edit: 'no', delete: 'no' },
  Team: { create: 'no', read: 'team', edit: 'no', delete: 'no' },
  AutoReplyRule: false,
  ProposalBrief: false,
  DailyReport: false,
  Conversation: { create: 'no', read: 'own', edit: 'own', delete: 'no' },
  SocialMessage: { create: 'yes', read: 'own', edit: 'no', delete: 'no' },
  Calendar: true,
  Contact: false, Account: false, Opportunity: false, Case: false, Meeting: false, Call: false, Document: false,
  Campaign: false, TargetList: false, MassEmail: false, EmailTemplate: false, Import: false,
};
// Employees may change task status and comment, nothing else on a task.
const readOnly = { read: 'yes', edit: 'no' };
const employeeFields = {
  // Staff may close a conversation, but not rewrite who/when; replies go through the reply box (hook-checked).
  Conversation: Object.fromEntries(['channel', 'customerId', 'customerName', 'contact', 'lastMessageAt', 'windowExpiresAt', 'assignedUser'].map(f => [f, readOnly])),
  Task: Object.fromEntries(['name', 'description', 'priority', 'dateStart', 'dateEnd', 'parent', 'assignedUser', 'teams'].map(f => [f, readOnly])),
};
const role = await upsert('Role', 'Employee', {
  name: 'Employee', data: employeeData, fieldData: employeeFields,
  assignmentPermission: 'no', userPermission: 'no', messagePermission: 'team', portalPermission: 'no',
  groupEmailAccountPermission: 'no', exportPermission: 'no', massUpdatePermission: 'no',
  dataPrivacyPermission: 'no', followerManagementPermission: 'no', auditPermission: 'no', mentionPermission: 'team', userCalendarPermission: 'no',
});
const team = await upsert('Team', 'Staff', { name: 'Staff', rolesIds: [role.id] });

// ---- Task statuses: Not Started / Started / Completed ----
await api('PUT', 'Admin/fieldManager/Task/status', {
  options: ['Not Started', 'Started', 'Completed'], notActualOptions: ['Completed'],
  style: { Completed: 'success', Started: 'primary' }, default: 'Not Started',
});

// ---- Users (placeholders; owner = built-in admin) ----
await api('PUT', 'User/' + (await find('User', { 'where[0][type]': 'equals', 'where[0][attribute]': 'userName', 'where[0][value]': 'admin' })).id, { firstName: 'Owner', lastName: '(Admin)' });
const employees = [];
// Placeholder test employees; production sets SKIP_PLACEHOLDER_USERS=1 and adds real staff with scripts/add-employee.mjs.
for (const n of process.env.SKIP_PLACEHOLDER_USERS ? [] : [1, 2]) {
  const u = await upsert('User', `emp${n}`, {
    userName: `emp${n}`, firstName: 'Employee', lastName: `${n}`, type: 'regular',
    emailAddress: `emp${n}@example.com`, password: process.env.EMPLOYEE_PASSWORD, passwordConfirm: process.env.EMPLOYEE_PASSWORD,
    teamsIds: [team.id], defaultTeamId: team.id, rolesIds: [role.id],
  }, 'userName');
  employees.push(u);
}
const empIds = employees.map(u => u.id);

// ---- Dashboard templates ----
// Only panels whose entities exist today. Attendance/messages/campaign panels are added in M2/M3/M4/M5.
// A list panel shows nothing without a field layout: what each row of a list panel displays, per entity.
const ROWS = {
  Task: [[{ name: 'name', link: true }], [{ name: 'assignedUser' }, { name: 'status' }, { name: 'dateEnd' }]],
  Attendance: [[{ name: 'assignedUser', link: true }], [{ name: 'checkIn' }, { name: 'checkOut' }, { name: 'hours' }, { name: 'isLate' }]],
  Email: [[{ name: 'subject', link: true }], [{ name: 'from' }, { name: 'aiCategory' }, { name: 'aiStatus' }]],
  Conversation: [[{ name: 'name', link: true }], [{ name: 'status' }, { name: 'assignedUser' }, { name: 'lastMessageAt' }]],
  Lead: [[{ name: 'name', link: true }], [{ name: 'status' }, { name: 'interestLevel' }, { name: 'emailAddress' }]],
};
const rec = (title, entityType, extra = {}) => ({ title, entityType, displayRecords: 10, expandedLayout: { rows: ROWS[entityType] }, ...extra });
const tpl = async (name, panels) => {
  const layout = [{ name: 'Home', columnCount: 4, layout: panels.map(([id, dashlet, o], i) => ({ id, name: dashlet, x: (i % 2) * 2, y: Math.floor(i / 2) * 4, width: 2, height: 4 })) }];
  const dashletsOptions = Object.fromEntries(panels.map(([id, , o]) => [id, o]));
  return upsert('DashboardTemplate', name, { name, layout, dashletsOptions });
};
const ownerTpl = await tpl('Owner', [
  ['o1', 'Records', rec('All open tasks by employee', 'Task', { primaryFilter: 'actual', sortBy: 'assignedUserName', sortDirection: 'asc' })],
  ['o2', 'Records', rec('Overdue tasks', 'Task', { primaryFilter: 'overdue', sortBy: 'dateEnd', sortDirection: 'asc' })],
  ['o5', 'Records', rec('Who is in now', 'Attendance', { primaryFilter: 'open', sortBy: 'checkIn', sortDirection: 'desc' })],
  ['o6', 'Records', rec('Late arrivals', 'Attendance', { primaryFilter: 'late', sortBy: 'checkIn', sortDirection: 'desc' })],
  ['o7', 'AttendanceMonthly', { title: 'Monthly hours per employee' }],
  ['o8', 'Records', rec('Needs human', 'Email', { primaryFilter: 'needsHuman', sortBy: 'dateSent', sortDirection: 'desc' })],
  ['o9', 'Records', rec('Campaign results', 'Campaign', {
    sortBy: 'createdAt', sortDirection: 'desc',
    expandedLayout: { rows: [[{ name: 'name', link: true }], [{ name: 'status' }, { name: 'sentCount' }, { name: 'openedCount' }, { name: 'bouncedCount' }, { name: 'optedOutCount' }]] },
  })],
  ['oa', 'Records', rec('Needs human (Instagram / Facebook)', 'Conversation', { primaryFilter: 'needsHuman', sortBy: 'lastMessageAt', sortDirection: 'desc' })],
  ['ob', 'AiControl', { title: 'AI control' }],
  ['od', 'SecurityStatus', { title: 'Security status' }],
  ['oc', 'DailyReports', { title: 'Daily reports' }],
  ['o3', 'Stream', { title: 'Activity stream' }],
  ['o4', 'Calendar', { title: 'Calendar' }],
]);
const empTpl = await tpl('Employee', [
  ['e0', 'AttendanceCheckIn', { title: 'Check In / Out' }],
  ['e1', 'Tasks', { title: 'My tasks', displayRecords: 10 }],
  ['e2', 'Records', rec('My leads', 'Lead', { boolFilterList: ['onlyMy'], sortBy: 'createdAt', sortDirection: 'desc' })],
  ['e4', 'Records', rec('My messages needing a reply', 'Email', { primaryFilter: 'needsHuman', boolFilterList: ['onlyMy'], sortBy: 'dateSent', sortDirection: 'desc' })],
  ['e5', 'Records', rec('My conversations needing a reply', 'Conversation', { primaryFilter: 'needsHuman', boolFilterList: ['onlyMy'], sortBy: 'lastMessageAt', sortDirection: 'desc' })],
  ['e3', 'Calendar', { title: 'My calendar' }],
]);
const owner = await find('User', { 'where[0][type]': 'equals', 'where[0][attribute]': 'userName', 'where[0][value]': 'admin' });
await api('POST', 'DashboardTemplate/action/deployToUsers', { id: ownerTpl.id, userIdList: [owner.id] });
if (empIds.length) await api('POST', 'DashboardTemplate/action/deployToUsers', { id: empTpl.id, userIdList: empIds });
for (const id of empIds) await api('PUT', `Preferences/${id}`, { dashboardLocked: true });

// ---- Overdue alert job (class shipped in the extension; see scripts/build-extension.sh) ----
await upsert('ScheduledJob', 'Overdue task alert', { name: 'Overdue task alert', job: 'OverdueTaskAlert', status: 'Active', scheduling: '0 8 * * *' });

await upsert('ScheduledJob', 'Auto-close forgotten attendance shifts', { name: 'Auto-close forgotten attendance shifts', job: 'AutoCloseAttendance', status: 'Active', scheduling: '5 0 * * *' });

// ---- Simplified navigation (unused CRM modules hidden) ----
// Explicit list; ACL hides entries an employee has no access to. Users/Teams live under Administration.
const tabList = ['Lead', 'Contact', 'Account', 'Email', 'Task', 'Calendar', 'Attendance', 'KnowledgeBaseArticle', 'AutoReplyRule', 'ProposalBrief', 'Conversation', 'DailyReport', 'Campaign', 'TargetList', 'EmailTemplate', 'Import'];
await api('PUT', 'Settings', { tabList, assignmentEmailNotifications: true, assignmentEmailNotificationsEntityList: ['Task'], attendanceOfficeStart: process.env.ATTENDANCE_OFFICE_START ?? '09:00', attendanceAllowedIps: process.env.ATTENDANCE_ALLOWED_IPS ?? '', attendanceTrustProxy: process.env.ATTENDANCE_TRUST_PROXY === 'true', auth2FA: true, auth2FAMethodList: ['Totp'], auth2FAForced: false, applicationName: process.env.APP_NAME ?? 'Office CRM' });
console.log('M1 setup done. Employees:', employees.map(u => u.userName).join(', ') || '(none)');
