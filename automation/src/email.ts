// Handles EspoCRM `Email.create` webhooks: classify, draft, and (only if allowed) auto-reply.
import type { Espo } from './espo.ts';
import { classifyAndDraft, type AiResult, type Category, type Incoming, type KbArticle } from './ai.ts';
import { classifyInterest } from './lead-ai.ts';

export interface Rule { category: string; channel: string; autoSend: boolean }

// Never auto-sent, whatever the Auto Reply Rules say (Appendix B).
const ALWAYS_HUMAN: Category[] = ['complaint', 'refund_legal', 'lead_reply', 'other'];

const NO_REPLY_SENDER = /(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?|newsletter|news|mailer)([._+@-]|$)/i;
const AUTO_SUBJECT = /^\s*(automatic reply|auto(matic)?[- ]?reply|auto:|out of office|undeliverable|delivery status|returned mail|mail delivery)/i;

/** Returns why an email must be ignored, or null when it is a real inbound customer message. */
export function skipReason(email: any, ownAddresses: Set<string>): string | null {
  if (email.status !== 'Archived') return `status ${email.status}`; // inbound mail from the group inbox is Archived
  if (email.aiStatus) return 'already processed';
  const from = String(email.from ?? '').trim().toLowerCase();
  if (!from) return 'no sender';
  if (ownAddresses.has(from)) return 'own address';
  if (NO_REPLY_SENDER.test(from.split('@')[0] + '@')) return 'no-reply/newsletter sender';
  if (AUTO_SUBJECT.test(String(email.name ?? ''))) return 'auto-generated subject';
  return null;
}

export type Decision = { aiStatus: 'auto_replied' | 'needs_human' | 'ignored'; send: boolean };

/** Most automatic replies one sender can get in 24 hours: a mail-bomb or a ping-pong with another robot must not run up costs or reputation. */
export const AUTO_REPLY_DAILY_CAP = Number(process.env.AUTO_REPLY_DAILY_CAP ?? 5);

export function decide(r: AiResult, rules: Rule[], channel: string, draftOnly: boolean, recentAutoReplies = 0, cap = AUTO_REPLY_DAILY_CAP): Decision {
  if (r.category === 'spam') return { aiStatus: 'ignored', send: false };
  const allowed = rules.some(x => x.category === r.category && x.channel === channel && x.autoSend);
  const send = r.confident && allowed && !ALWAYS_HUMAN.includes(r.category) && !draftOnly && r.reply.length > 0 && recentAutoReplies < cap;
  return { aiStatus: send ? 'auto_replied' : 'needs_human', send };
}

const stripHtml = (s: string) =>
  s.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
const plain = (e: any) => (e.bodyPlain || stripHtml(e.body ?? '')).slice(0, 6000);

export class EmailProcessor {
  private ownCache: { at: number; set: Set<string> } = { at: 0, set: new Set() };

  private espo: Espo;
  private log: (o: object) => void;

  constructor(espo: Espo, log: (o: object) => void = o => console.log(JSON.stringify(o))) {
    this.espo = espo;
    this.log = log;
  }

  private async ownAddresses(): Promise<Set<string>> {
    if (Date.now() - this.ownCache.at < 60_000) return this.ownCache.set;
    const set = new Set((await this.espo.get<{ list: string[] }>('Email/action/ownAddresses')).list);
    this.ownCache = { at: Date.now(), set };
    return set;
  }

  private async history(email: any): Promise<string[]> {
    const out: string[] = [];
    let id = email.repliedId;
    for (let i = 0; id && i < 4; i++) {
      const e = await this.espo.get(`Email/${id}`);
      out.unshift(`From: ${e.from}\n${plain(e).slice(0, 1500)}`);
      id = e.repliedId;
    }
    return out;
  }

  async handle(id: string): Promise<void> {
    const email = await this.espo.get(`Email/${id}`);
    const skip = skipReason(email, await this.ownAddresses());
    // An auto-generated reply (e.g. out of office) is never answered, but a lead's one must still be tagged.
    if (skip && skip !== 'auto-generated subject') return this.log({ event: 'skip', id, skip });

    const lead = (await this.espo.list('Lead', {
      'where[0][type]': 'equals', 'where[0][attribute]': 'emailAddress', 'where[0][value]': email.from,
      select: 'id,name,status,assignedUserId,createdById,proposalBriefId', maxSize: '1',
    }))[0];
    if (lead?.proposalBriefId) return this.handleLeadReply(email, lead);
    if (skip) return this.log({ event: 'skip', id, skip });

    const [articles, rules, settings] = await Promise.all([
      this.espo.list('KnowledgeBaseArticle', { 'where[0][type]': 'equals', 'where[0][attribute]': 'status', 'where[0][value]': 'Published', select: 'name,bodyPlain,body' }),
      this.espo.list<Rule>('AutoReplyRule', { select: 'category,channel,autoSend' }),
      this.espo.get('Settings'),
    ]);
    const kb: KbArticle[] = articles.map((a: any) => ({ name: a.name, text: a.bodyPlain || stripHtml(a.body ?? '') }));
    const msg: Incoming = { from: email.from, subject: email.name ?? '', body: plain(email), history: await this.history(email) };

    let result: AiResult;
    try {
      result = await classifyAndDraft(msg, kb);
    } catch (e) {
      // AI failure must never lose a message: a human picks it up.
      this.log({ event: 'ai_error', id, error: String(e) });
      await this.espo.put(`Email/${id}`, { aiStatus: 'needs_human' });
      return;
    }

    const since = Date.now() - 24 * 3600e3;
    const recent = (await this.espo.list('Email', { 'where[0][type]': 'equals', 'where[0][attribute]': 'from', 'where[0][value]': email.from, 'where[1][type]': 'equals', 'where[1][attribute]': 'aiStatus', 'where[1][value]': 'auto_replied', select: 'createdAt', maxSize: '20' }).catch(() => null))
      ?.filter((e: any) => Date.parse(String(e.createdAt).replace(' ', 'T') + 'Z') > since).length ?? AUTO_REPLY_DAILY_CAP; // lookup failed: fail safe, a person decides
    const d = decide(result, rules, 'email', settings.aiDraftOnly !== false || settings.aiAutoReplyPaused === true, recent);
    // Safe default first: if we crash before sending, a person sees the draft and nothing is ever sent twice.
    await this.espo.put(`Email/${id}`, { aiCategory: result.category, aiDraft: result.reply, aiDraftOriginal: result.reply, aiStatus: d.send ? 'needs_human' : d.aiStatus });
    this.log({ event: 'classified', id, category: result.category, confident: result.confident, aiStatus: d.aiStatus, reason: result.reason });

    if (!d.send) return;
    try {
      // EspoCRM sends from the group mailbox, threaded to the original, and marks the email auto_replied.
      await this.espo.post('Email/action/sendAiDraft', { id, body: result.reply });
    } catch (e) {
      this.log({ event: 'send_error', id, error: String(e) });
    }
  }

  private exclusionListId?: string;

  /** The Target List that follow-up Mass Emails exclude: leads who replied. */
  private async exclusionList(): Promise<string> {
    if (this.exclusionListId) return this.exclusionListId;
    const name = 'Proposal replies and opt-outs';
    const ex = (await this.espo.list('TargetList', { 'where[0][type]': 'equals', 'where[0][attribute]': 'name', 'where[0][value]': name, select: 'id', maxSize: '1' }))[0];
    return (this.exclusionListId = ex?.id ?? (await this.espo.post('TargetList', { name })).id);
  }

  /** A reply to a proposal: tag interest, stop follow-ups, hot lead => Task. A person writes the answer. */
  private async handleLeadReply(email: any, lead: any): Promise<void> {
    const interest = await classifyInterest(`${email.name ?? ''}\n${plain(email)}`);
    const ooo = interest === 'out_of_office'; // an auto-reply is not a real answer: keep following up
    await this.espo.put(`Email/${email.id}`, { aiCategory: 'lead_reply', aiStatus: ooo ? 'ignored' : 'needs_human' });
    const status = interest === 'interested' ? 'In Process' : interest === 'not_interested' ? 'Dead' : undefined;
    await this.espo.put(`Lead/${lead.id}`, { interestLevel: interest, ...(status ? { status } : {}) });
    if (!ooo) {
      await this.espo.post(`Lead/${lead.id}/targetLists`, { id: await this.exclusionList() })
        .catch(e => this.log({ event: 'exclude_error', id: lead.id, error: String(e) }));
    }
    if (interest === 'interested') {
      await this.espo.post('Task', {
        name: `Hot lead replied: ${lead.name}`, parentType: 'Lead', parentId: lead.id, priority: 'High',
        assignedUserId: lead.assignedUserId ?? lead.createdById, description: `Subject: ${email.name}\n\n${plain(email).slice(0, 1000)}\n\nTip: open the lead and press 'Send proposal PDF' to email the branded proposal.`,
      });
    }
    this.log({ event: 'lead_reply', emailId: email.id, leadId: lead.id, interest });
  }
}
