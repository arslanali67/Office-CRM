// Optional automatic assignment of new emails / conversations to employees (settings: autoAssign, autoAssignOnlyCheckedIn).
// Balanced by open workload: the employee with the fewest messages still waiting for a reply gets the next one.
import type { Espo } from './espo.ts';

/** Categories the owner handles personally; they are never handed to an employee automatically. */
export const OWNER_ONLY = new Set(['complaint', 'refund_legal', 'spam']);

export interface Candidate { id: string; load: number }

/** Fewest open items wins; ties are broken at random so nobody is always first. */
export function pick(candidates: Candidate[], rand: () => number = Math.random): string | undefined {
  if (!candidates.length) return undefined;
  const min = Math.min(...candidates.map(c => c.load));
  const best = candidates.filter(c => c.load === min);
  return best[Math.floor(rand() * best.length)].id;
}

export class Assigner {
  private espo: Espo;
  private log: (o: object) => void;

  constructor(espo: Espo, log: (o: object) => void = o => console.log(JSON.stringify(o))) {
    this.espo = espo;
    this.log = log;
  }

  /** The employee who should get the next message, or undefined (setting off, nobody available, or an owner-only category). */
  async next(category: string): Promise<string | undefined> {
    if (OWNER_ONLY.has(category)) return undefined;
    const settings = await this.espo.get('Settings');
    if (!settings.autoAssign) return undefined;

    let staff: { id: string }[] = (await this.espo.list('User', { 'where[0][type]': 'equals', 'where[0][attribute]': 'type', 'where[0][value]': 'regular', select: 'id,isActive' })).filter((u: any) => u.isActive);
    if (settings.autoAssignOnlyCheckedIn !== false) {
      const open = new Set((await this.espo.list('Attendance', { orderBy: 'checkIn', order: 'desc', select: 'assignedUserId,checkOut', maxSize: '200' })).filter((a: any) => !a.checkOut).map((a: any) => a.assignedUserId));
      staff = staff.filter(u => open.has(u.id));
    }
    if (!staff.length) return undefined;

    const load = new Map(staff.map(u => [u.id, 0]));
    const waiting = [
      ...(await this.espo.list('Email', { 'where[0][type]': 'equals', 'where[0][attribute]': 'aiStatus', 'where[0][value]': 'needs_human', select: 'assignedUserId', maxSize: '200' })),
      ...(await this.espo.list('Conversation', { 'where[0][type]': 'equals', 'where[0][attribute]': 'status', 'where[0][value]': 'needs_human', select: 'assignedUserId', maxSize: '200' })),
    ];
    for (const w of waiting) if (load.has(w.assignedUserId)) load.set(w.assignedUserId, load.get(w.assignedUserId)! + 1);

    const id = pick([...load].map(([id, l]) => ({ id, load: l })));
    this.log({ event: 'auto_assign', category, assignee: id, loads: Object.fromEntries(load) });
    return id;
  }
}
