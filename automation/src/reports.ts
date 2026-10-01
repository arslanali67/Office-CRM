// Nightly numbers for the owner: one DailyReport record per day (office time zone).
// Usage from the server: node src/reports.ts 2026-10-01   (computes and stores that day)
import type { Espo } from './espo.ts';

const MIN = 60_000;
const ts = (s?: string | null) => (s ? Date.parse(s.replace(' ', 'T') + 'Z') : NaN); // EspoCRM stores UTC
const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (a: number, b: number) => (b ? round1((a / b) * 100) : 0);

/** Offset (ms) of a time zone from UTC at an instant. */
function tzOffsetMs(tz: string, at: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(at)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(at / 1000) * 1000;
}

export function localDate(at: number, tz: string): string {
  return new Date(at + tzOffsetMs(tz, at)).toISOString().slice(0, 10);
}

/** [start, end) of a calendar day in a time zone, as UTC milliseconds. */
export function dayRange(date: string, tz: string): { start: number; end: number } {
  const at = (d: string) => { const g = Date.parse(`${d}T00:00:00Z`); return g - tzOffsetMs(tz, g - tzOffsetMs(tz, g)); };
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 24 * 3600e3).toISOString().slice(0, 10);
  return { start: at(date), end: at(next) };
}

export interface RawData {
  tasks: { assignedUserId?: string; assignedUserName?: string; status: string; dateEnd?: string | null; dateCompleted?: string | null }[];
  attendance: { assignedUserId?: string; assignedUserName?: string; checkIn: string; hours?: number | null; isLate?: boolean }[];
  emails: { id: string; status: string; from?: string; dateSent?: string | null; createdAt: string; repliedId?: string | null; aiStatus?: string | null; aiDraftOriginal?: string | null; aiEdited?: boolean | null }[];
  messages: { conversationId: string; direction: string; createdAt: string; status: string; aiDraftUsed?: boolean | null; aiEdited?: boolean | null }[];
  conversations: Record<string, string>; // id -> channel
  campaigns: { sentCount?: number; openedCount?: number; bouncedCount?: number; optedOutCount?: number }[];
  ownAddresses: Set<string>;
}

const HANDLED = new Set(['auto_replied', 'sent', 'needs_human']);

export function buildReport(date: string, tz: string, raw: RawData, now = Date.now()) {
  const { start, end } = dayRange(date, tz);
  const inDay = (t: number) => t >= start && t < end;
  const asOf = Math.min(now, end); // "overdue" is judged at the end of that day, or now for today

  // --- tasks ---
  const emp = new Map<string, { name: string; open: number; overdue: number; completed: number; onTime: number; hours: number }>();
  const e = (id?: string, name?: string) => {
    const key = id ?? '-';
    if (!emp.has(key)) emp.set(key, { name: name ?? 'Unassigned', open: 0, overdue: 0, completed: 0, onTime: 0, hours: 0 });
    return emp.get(key)!;
  };
  let open = 0, overdue = 0, completed = 0, onTime = 0;
  for (const t of raw.tasks) {
    const who = e(t.assignedUserId, t.assignedUserName);
    if (t.status === 'Completed') {
      const done = ts(t.dateCompleted);
      if (inDay(done)) {
        completed++; who.completed++;
        const due = ts(t.dateEnd);
        if (Number.isNaN(due) || done <= due) { onTime++; who.onTime++; }
      }
    } else if (t.status === 'Not Started' || t.status === 'Started') {
      open++; who.open++;
      if (ts(t.dateEnd) < asOf) { overdue++; who.overdue++; }
    }
  }

  // --- attendance ---
  let hours = 0, late = 0;
  for (const a of raw.attendance) {
    if (!inDay(ts(a.checkIn))) continue;
    hours += a.hours ?? 0;
    e(a.assignedUserId, a.assignedUserName).hours += a.hours ?? 0;
    if (a.isLate) late++;
  }

  // --- messages ---
  const inboundEmails = raw.emails.filter(m => m.status === 'Archived' && !raw.ownAddresses.has(String(m.from ?? '').toLowerCase()) && inDay(ts(m.dateSent ?? m.createdAt)));
  const firstReply = new Map<string, number>();
  for (const m of raw.emails) {
    if (m.status !== 'Sent' || !m.repliedId) continue;
    const t = ts(m.dateSent ?? m.createdAt);
    if (!(firstReply.get(m.repliedId) <= t)) firstReply.set(m.repliedId, t);
  }
  const waits: number[] = [];
  for (const m of inboundEmails) {
    const r = firstReply.get(m.id);
    if (r !== undefined) waits.push((r - ts(m.dateSent ?? m.createdAt)) / MIN);
  }
  const dmIn = raw.messages.filter(m => m.direction === 'in' && inDay(ts(m.createdAt)));
  const outs = raw.messages.filter(m => m.direction === 'out').map(m => ({ c: m.conversationId, t: ts(m.createdAt) })).sort((a, b) => a.t - b.t);
  for (const m of dmIn) {
    const t = ts(m.createdAt);
    const r = outs.find(o => o.c === m.conversationId && o.t > t);
    if (r) waits.push((r.t - t) / MIN);
  }
  const channelCount = (ch: string) => dmIn.filter(m => raw.conversations[m.conversationId] === ch).length;

  const handled = [...inboundEmails.map(m => m.aiStatus), ...dmIn.map(m => m.status)].filter(s => s && HANDLED.has(s)) as string[];
  const auto = handled.filter(s => s === 'auto_replied').length;

  // drafts a person sent (email: Send AI draft; DM: Use AI draft in the chat), and how many of them were changed first
  const used = [
    ...inboundEmails.filter(m => m.aiStatus === 'sent' && m.aiDraftOriginal).map(m => !!m.aiEdited),
    ...raw.messages.filter(m => m.direction === 'out' && m.status === 'sent' && m.aiDraftUsed && inDay(ts(m.createdAt))).map(m => !!m.aiEdited),
  ];
  const edited = used.filter(Boolean).length;

  const sum = (k: 'sentCount' | 'openedCount' | 'bouncedCount' | 'optedOutCount') => raw.campaigns.reduce((n, c) => n + (c[k] ?? 0), 0);

  return {
    fields: {
      date, tasksOpen: open, tasksOverdue: overdue, overdueRate: pct(overdue, open), tasksCompleted: completed, tasksCompletedOnTime: onTime, onTimeRate: pct(onTime, completed),
      attendanceHours: round1(hours), lateArrivals: late, emailsIn: inboundEmails.length, facebookIn: channelCount('facebook'), instagramIn: channelCount('instagram'),
      avgResponseMinutes: waits.length ? round1(waits.reduce((a, b) => a + b, 0) / waits.length) : 0,
      aiAutoReplied: auto, aiHandled: handled.length, aiAutomationRate: pct(auto, handled.length),
      draftsUsed: used.length, draftsEdited: edited, editedDraftRate: pct(edited, used.length),
      campaignSent: sum('sentCount'), campaignOpened: sum('openedCount'), campaignBounced: sum('bouncedCount'), campaignOptedOut: sum('optedOutCount'),
    },
    perEmployee: [...emp.values()].map(x => ({ ...x, hours: round1(x.hours) })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------------- fetching ----------------

async function everything(espo: Espo, entity: string, select: string): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await espo.get<{ list: any[] }>(`${entity}?${new URLSearchParams({ select, maxSize: '200', offset: String(offset) })}`);
    out.push(...page.list);
    if (page.list.length < 200) return out;
  }
}

/** Newest first, stops at the first record older than `sinceMs` (date filters on the API are unreliable, this is not). */
async function since(espo: Espo, entity: string, field: string, sinceMs: number, select: string): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await espo.get<{ list: any[] }>(`${entity}?${new URLSearchParams({ select: `${select},${field}`, maxSize: '200', offset: String(offset), orderBy: field, order: 'desc' })}`);
    for (const r of page.list) {
      if (ts(r[field]) < sinceMs) return out;
      out.push(r);
    }
    if (page.list.length < 200) return out;
  }
}

export async function computeReport(espo: Espo, date: string): Promise<ReturnType<typeof buildReport>> {
  const tz = (await espo.get('Settings')).timeZone || 'UTC';
  const { start } = dayRange(date, tz);
  const [tasks, attendance, emails, messages, conversations, campaigns, own] = await Promise.all([
    everything(espo, 'Task', 'assignedUserId,assignedUserName,status,dateEnd,dateCompleted'),
    since(espo, 'Attendance', 'checkIn', start - 24 * 3600e3, 'assignedUserId,assignedUserName,hours,isLate'),
    since(espo, 'Email', 'createdAt', start - 24 * 3600e3, 'status,dateSent,repliedId,aiStatus,fromAddress,aiDraftOriginal,aiEdited'),
    since(espo, 'SocialMessage', 'createdAt', start - 24 * 3600e3, 'conversationId,direction,status,aiDraftUsed,aiEdited'),
    everything(espo, 'Conversation', 'channel'),
    everything(espo, 'Campaign', 'sentCount,openedCount,bouncedCount,optedOutCount'),
    espo.get<{ list: string[] }>('Email/action/ownAddresses'),
  ]);
  return buildReport(date, tz, {
    tasks, attendance, emails: emails.map((m: any) => ({ ...m, from: m.fromAddress })), messages,
    conversations: Object.fromEntries(conversations.map((c: any) => [c.id, c.channel])), campaigns, ownAddresses: new Set(own.list),
  });
}

/** Stores the report (one per day) and returns the record id. */
export async function storeReport(espo: Espo, date: string): Promise<string> {
  const { fields, perEmployee } = await computeReport(espo, date);
  const data = { ...fields, details: JSON.stringify({ perEmployee }), computedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') };
  const existing = (await espo.list('DailyReport', { 'where[0][type]': 'equals', 'where[0][attribute]': 'date', 'where[0][value]': date, select: 'id', maxSize: '1' }))[0];
  return existing ? (await espo.put(`DailyReport/${existing.id}`, data)).id : (await espo.post('DailyReport', data)).id;
}

/** Keeps today's and yesterday's reports fresh; the first run after midnight finalises yesterday. */
export function startReportScheduler(espo: Espo, log: (o: object) => void, everyMs = 3600e3): void {
  const run = async () => {
    try {
      const tz = (await espo.get('Settings')).timeZone || 'UTC';
      const today = localDate(Date.now(), tz);
      const yesterday = localDate(Date.now() - 24 * 3600e3, tz);
      for (const d of [yesterday, today]) await storeReport(espo, d);
      log({ event: 'reports_done', dates: [yesterday, today] });
    } catch (e) {
      log({ event: 'reports_error', error: String(e) });
    }
  };
  setTimeout(run, 30_000);
  setInterval(run, everyMs);
}

if (import.meta.main) {
  const { Espo: EspoClient } = await import('./espo.ts');
  const espo = new EspoClient(process.env.ESPO_URL ?? 'http://espocrm', process.env.ESPO_API_KEY ?? '');
  const tz = (await espo.get('Settings')).timeZone || 'UTC';
  const date = process.argv[2] ?? localDate(Date.now(), tz);
  console.log(JSON.stringify({ date, id: await storeReport(espo, date) }));
}
