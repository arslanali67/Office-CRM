import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, dayRange, localDate, type RawData } from '../src/reports.ts';

const empty = (): RawData => ({ tasks: [], attendance: [], emails: [], messages: [], conversations: {}, campaigns: [], ownAddresses: new Set() });
const T = 'UTC';

test('day ranges honour the office time zone', () => {
  assert.deepEqual(dayRange('2026-10-01', 'UTC'), { start: Date.parse('2026-10-01T00:00:00Z'), end: Date.parse('2026-10-02T00:00:00Z') });
  const karachi = dayRange('2026-10-01', 'Asia/Karachi'); // UTC+5
  assert.equal(karachi.start, Date.parse('2026-09-30T19:00:00Z'));
  assert.equal(karachi.end - karachi.start, 24 * 3600e3);
  const ny = dayRange('2026-07-01', 'America/New_York'); // UTC-4 in summer
  assert.equal(ny.start, Date.parse('2026-07-01T04:00:00Z'));
  assert.equal(localDate(Date.parse('2026-09-30T20:00:00Z'), 'Asia/Karachi'), '2026-10-01');
  assert.equal(localDate(Date.parse('2026-09-30T20:00:00Z'), 'UTC'), '2026-09-30');
});

test('tasks: open, overdue, per-employee, completed on time', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const raw = empty();
  raw.tasks = [
    { assignedUserId: 'a', assignedUserName: 'Ann', status: 'Started', dateEnd: '2026-10-01 09:00:00' },       // overdue
    { assignedUserId: 'a', assignedUserName: 'Ann', status: 'Not Started', dateEnd: '2026-10-02 09:00:00' },   // open, not due
    { assignedUserId: 'b', assignedUserName: 'Bob', status: 'Not Started', dateEnd: null },                     // open, no due date
    { assignedUserId: 'b', assignedUserName: 'Bob', status: 'Completed', dateEnd: '2026-10-01 11:00:00', dateCompleted: '2026-10-01 10:00:00' }, // on time
    { assignedUserId: 'b', assignedUserName: 'Bob', status: 'Completed', dateEnd: '2026-10-01 08:00:00', dateCompleted: '2026-10-01 10:30:00' }, // late
    { assignedUserId: 'b', assignedUserName: 'Bob', status: 'Completed', dateEnd: '2026-09-01 08:00:00', dateCompleted: '2026-09-01 08:00:00' }, // other day
  ];
  const r = buildReport('2026-10-01', T, raw, now);
  assert.deepEqual([r.fields.tasksOpen, r.fields.tasksOverdue, r.fields.overdueRate], [3, 1, 33.3]);
  assert.deepEqual([r.fields.tasksCompleted, r.fields.tasksCompletedOnTime, r.fields.onTimeRate], [2, 1, 50]);
  const bob = r.perEmployee.find(x => x.name === 'Bob')!;
  assert.deepEqual([bob.open, bob.completed, bob.onTime], [1, 2, 1]);
});

test('an old day is judged at its own end, not at "now"', () => {
  const raw = empty();
  raw.tasks = [{ status: 'Started', dateEnd: '2026-10-02 08:00:00' }]; // due the day after
  assert.equal(buildReport('2026-10-01', T, raw, Date.parse('2026-10-05T00:00:00Z')).fields.tasksOverdue, 0);
});

test('attendance hours and late arrivals count only that day', () => {
  const raw = empty();
  raw.attendance = [
    { assignedUserId: 'a', assignedUserName: 'Ann', checkIn: '2026-10-01 05:00:00', hours: 8.25, isLate: true },
    { assignedUserId: 'a', assignedUserName: 'Ann', checkIn: '2026-09-30 05:00:00', hours: 8, isLate: true },
    { assignedUserId: 'b', assignedUserName: 'Bob', checkIn: '2026-10-01 04:00:00', hours: null },
  ];
  const r = buildReport('2026-10-01', T, raw);
  assert.deepEqual([r.fields.attendanceHours, r.fields.lateArrivals], [8.3, 1]);
});

test('messages per channel, first-response time, AI automation rate', () => {
  const raw = empty();
  raw.ownAddresses = new Set(['support@crm.test']);
  raw.emails = [
    { id: 'e1', status: 'Archived', from: 'c1@x.com', dateSent: '2026-10-01 10:00:00', createdAt: '2026-10-01 10:00:01', aiStatus: 'auto_replied' },
    { id: 'e2', status: 'Archived', from: 'c2@x.com', dateSent: '2026-10-01 11:00:00', createdAt: '2026-10-01 11:00:01', aiStatus: 'needs_human' },
    { id: 'e3', status: 'Archived', from: 'support@crm.test', dateSent: '2026-10-01 11:30:00', createdAt: '2026-10-01 11:30:00' },   // our own: not counted
    { id: 'r1', status: 'Sent', dateSent: '2026-10-01 10:10:00', createdAt: '2026-10-01 10:10:00', repliedId: 'e1' },                     // 10 min
    { id: 'r2', status: 'Sent', dateSent: '2026-10-01 11:30:00', createdAt: '2026-10-01 11:30:00', repliedId: 'e2' },                     // 30 min
  ];
  raw.conversations = { c1: 'facebook', c2: 'instagram' };
  raw.messages = [
    { conversationId: 'c1', direction: 'in', createdAt: '2026-10-01 09:00:00', status: 'auto_replied' },
    { conversationId: 'c1', direction: 'out', createdAt: '2026-10-01 09:02:00', status: 'sent' },                                           // 2 min
    { conversationId: 'c2', direction: 'in', createdAt: '2026-10-01 09:00:00', status: 'sent' },
    { conversationId: 'c2', direction: 'out', createdAt: '2026-10-01 09:08:00', status: 'sent' },                                           // 8 min
    { conversationId: 'c2', direction: 'in', createdAt: '2026-09-30 09:00:00', status: 'needs_human' },                                     // other day
  ];
  const f = buildReport('2026-10-01', T, raw).fields;
  assert.deepEqual([f.emailsIn, f.facebookIn, f.instagramIn], [2, 1, 1]);
  assert.equal(f.avgResponseMinutes, 12.5); // (10 + 30 + 2 + 8) / 4
  assert.deepEqual([f.aiHandled, f.aiAutoReplied, f.aiAutomationRate], [4, 2, 50]);
});

test('campaign totals and an empty day do not break', () => {
  const raw = empty();
  raw.campaigns = [{ sentCount: 10, openedCount: 4, bouncedCount: 1, optedOutCount: 0 }, { sentCount: 5 }];
  const f = buildReport('2026-10-01', T, raw).fields;
  assert.deepEqual([f.campaignSent, f.campaignOpened, f.campaignBounced, f.campaignOptedOut], [15, 4, 1, 0]);
  assert.deepEqual([f.tasksOpen, f.overdueRate, f.avgResponseMinutes, f.aiAutomationRate], [0, 0, 0, 0]);
});

test('edited-draft rate: drafts a person sent, and how many were changed', () => {
  const raw = empty();
  raw.emails = [
    { id: 'a', status: 'Archived', from: 'c1@x.com', dateSent: '2026-10-01 10:00:00', createdAt: '2026-10-01 10:00:00', aiStatus: 'sent', aiDraftOriginal: 'hi', aiEdited: false },
    { id: 'b', status: 'Archived', from: 'c2@x.com', dateSent: '2026-10-01 11:00:00', createdAt: '2026-10-01 11:00:00', aiStatus: 'sent', aiDraftOriginal: 'hi', aiEdited: true },
    { id: 'c', status: 'Archived', from: 'c3@x.com', dateSent: '2026-10-01 12:00:00', createdAt: '2026-10-01 12:00:00', aiStatus: 'sent' },                         // person wrote their own: not a draft
    { id: 'd', status: 'Archived', from: 'c4@x.com', dateSent: '2026-10-01 13:00:00', createdAt: '2026-10-01 13:00:00', aiStatus: 'auto_replied', aiDraftOriginal: 'x' }, // AI sent it: not a person
  ];
  raw.messages = [
    { conversationId: 'c1', direction: 'out', createdAt: '2026-10-01 09:00:00', status: 'sent', aiDraftUsed: true, aiEdited: true },
    { conversationId: 'c1', direction: 'out', createdAt: '2026-10-01 09:30:00', status: 'sent', aiDraftUsed: false },
    { conversationId: 'c1', direction: 'out', createdAt: '2026-09-30 09:00:00', status: 'sent', aiDraftUsed: true, aiEdited: false }, // other day
  ];
  const f = buildReport('2026-10-01', T, raw).fields;
  assert.deepEqual([f.draftsUsed, f.draftsEdited, f.editedDraftRate], [3, 2, 66.7]);
  assert.equal(buildReport('2026-10-01', T, empty()).fields.editedDraftRate, 0);
});
