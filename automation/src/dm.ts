// Instagram / Facebook DMs: store in EspoCRM, classify + draft with the AI, auto-send only when safe, send human replies.
import type { Espo } from './espo.ts';
import { classifyAndDraft, type AiResult, type KbArticle } from './ai.ts';
import { decide, type Rule } from './email.ts';
import { windowOpen, toEspoDate, type InboundDm, type Meta } from './meta.ts';
import { Assigner } from './assign.ts';

const DAY = 24 * 3600e3;
const stripHtml = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const eq = (attribute: string, value: string, i: number) => ({ [`where[${i}][type]`]: 'equals', [`where[${i}][attribute]`]: attribute, [`where[${i}][value]`]: value });

export class DmProcessor {
  private espo: Espo;
  private meta: Meta;
  private assigner: Assigner;
  private log: (o: object) => void;

  constructor(espo: Espo, meta: Meta, log: (o: object) => void = o => console.log(JSON.stringify(o))) {
    this.espo = espo;
    this.meta = meta;
    this.assigner = new Assigner(espo, log);
    this.log = log;
  }

  /** Exactly one Contact with this full name, else none: a wrong link is worse than no link. */
  private async findContact(name: string | undefined): Promise<string | undefined> {
    const parts = (name ?? '').trim().split(/\s+/);
    if (parts.length < 2) return undefined;
    const found = await this.espo.list('Contact', { ...eq('firstName', parts[0], 0), ...eq('lastName', parts.slice(1).join(' '), 1), select: 'id', maxSize: '2' });
    return found.length === 1 ? found[0].id : undefined;
  }

  private async conversation(dm: InboundDm): Promise<any> {
    const existing = (await this.espo.list('Conversation', { ...eq('channel', dm.channel, 0), ...eq('customerId', dm.customerId, 1), maxSize: '1' }))[0];
    if (existing) return existing;
    const name = await this.meta.profileName(dm.customerId, dm.channel);
    const contactId = await this.findContact(name);
    return this.espo.post('Conversation', {
      channel: dm.channel, customerId: dm.customerId, customerName: name ?? null, contactId: contactId ?? null,
      status: 'open', lastMessageAt: toEspoDate(dm.timestamp), windowExpiresAt: toEspoDate(dm.timestamp + DAY),
    });
  }

  async handleInbound(dm: InboundDm): Promise<void> {
    if (dm.isEcho) return this.log({ event: 'dm_skip', mid: dm.mid, why: 'echo' });

    // Meta retries deliveries: one message per Meta message id, ever.
    if ((await this.espo.list('SocialMessage', { ...eq('externalId', dm.mid, 0), select: 'id', maxSize: '1' })).length) {
      return this.log({ event: 'dm_skip', mid: dm.mid, why: 'duplicate' });
    }

    const conv = await this.conversation(dm);
    const text = dm.text || (dm.hasAttachment ? '[attachment]' : '');
    let message: any;
    try {
      message = await this.espo.post('SocialMessage', { conversationId: conv.id, direction: 'in', text, externalId: dm.mid, status: 'new' });
    } catch (e) {
      return this.log({ event: 'dm_skip', mid: dm.mid, why: 'duplicate (race)', error: String(e).slice(0, 120) });
    }
    const windowEnd = Math.max(dm.timestamp + DAY, Date.parse((conv.windowExpiresAt ?? '').replace(' ', 'T') + 'Z') || 0);
    await this.espo.put(`Conversation/${conv.id}`, { lastMessageAt: toEspoDate(dm.timestamp), windowExpiresAt: toEspoDate(windowEnd) });

    // Anything the AI cannot handle lands in the Needs-human queue with whatever draft exists.
    let result: AiResult = { category: 'other', confident: false, reply: '', reason: 'attachment only' };
    if (dm.text) {
      try {
        const [articles, rules, settings, history] = await Promise.all([
          this.espo.list('KnowledgeBaseArticle', { ...eq('status', 'Published', 0), select: 'name,bodyPlain,body' }),
          this.espo.list<Rule>('AutoReplyRule', { select: 'category,channel,autoSend' }),
          this.espo.get('Settings'),
          this.history(conv.id, message.id),
        ]);
        const kb: KbArticle[] = articles.map((a: any) => ({ name: a.name, text: a.bodyPlain || stripHtml(a.body ?? '') }));
        result = await classifyAndDraft({ from: conv.customerName ?? conv.customerId, subject: '', body: dm.text, history }, kb);
        const since = Date.now() - 24 * 3600e3;
        const recent = (await this.espo.list('SocialMessage', { ...eq('conversationId', conv.id, 0), ...eq('status', 'auto_replied', 1), select: 'createdAt', maxSize: '20' }))
          .filter((m: any) => Date.parse(String(m.createdAt).replace(' ', 'T') + 'Z') > since).length;
        const d = decide(result, rules, dm.channel, settings.aiDraftOnly !== false || settings.aiAutoReplyPaused === true, recent); // paused = emergency switch
        await this.finish(conv, message, dm, result, d);
        if (d.aiStatus === 'needs_human') await this.assign(conv, result.category);
        return;
      } catch (e) {
        this.log({ event: 'dm_ai_error', mid: dm.mid, error: String(e) });
      }
    }
    await this.espo.put(`SocialMessage/${message.id}`, { aiCategory: result.category, aiDraft: result.reply, status: 'needs_human' });
    await this.espo.put(`Conversation/${conv.id}`, { status: 'needs_human' });
    await this.assign(conv, result.category);
  }

  /** Optional automatic assignment; an existing assignee is kept (the same person keeps talking to the same customer). */
  private async assign(conv: any, category: string): Promise<void> {
    if (conv.assignedUserId) return;
    const who = await this.assigner.next(category).catch(() => undefined);
    if (who) await this.espo.put(`Conversation/${conv.id}`, { assignedUserId: who }).catch(e => this.log({ event: 'assign_error', id: conv.id, error: String(e) }));
  }

  private async history(conversationId: string, exceptId: string): Promise<string[]> {
    const q = { ...eq('conversationId', conversationId, 0), orderBy: 'createdAt', order: 'desc', maxSize: '7', select: 'id,direction,text' };
    return (await this.espo.list('SocialMessage', q)).filter((m: any) => m.id !== exceptId).reverse()
      .map((m: any) => `${m.direction === 'out' ? 'We' : 'Customer'}: ${String(m.text).slice(0, 500)}`);
  }

  private async finish(conv: any, message: any, dm: InboundDm, result: AiResult, d: { aiStatus: string; send: boolean }): Promise<void> {
    // Safe default first: a crash before sending leaves the message in the human queue, never double-sent.
    await this.espo.put(`SocialMessage/${message.id}`, { aiCategory: result.category, aiDraft: result.reply, status: d.send ? 'needs_human' : d.aiStatus });
    await this.espo.put(`Conversation/${conv.id}`, { status: d.aiStatus === 'needs_human' || d.send ? 'needs_human' : 'open' });
    this.log({ event: 'dm_classified', mid: dm.mid, category: result.category, confident: result.confident, status: d.aiStatus });
    if (!d.send) return;
    try {
      const sentMid = await this.meta.sendText(dm.customerId, result.reply);
      // The customer now has the reply. Mark that first so a later hiccup can never make a person answer twice.
      await this.espo.put(`SocialMessage/${message.id}`, { status: 'auto_replied' });
      await this.espo.put(`Conversation/${conv.id}`, { status: 'open' });
      await this.espo.post('SocialMessage', { conversationId: conv.id, direction: 'out', text: result.reply, externalId: sentMid, status: 'sent' })
        .catch(e => this.log({ event: 'dm_record_error', mid: dm.mid, sentMid, error: String(e) })); // best effort: the history entry
    } catch (e) {
      this.log({ event: 'dm_send_error', mid: dm.mid, error: String(e) });
    }
  }

  /** A person wrote a reply in EspoCRM (SocialMessage.create, direction out, status new): send it through Meta. */
  async handleOutbound(messageId: string): Promise<void> {
    const m = await this.espo.get(`SocialMessage/${messageId}`);
    if (m.direction !== 'out' || m.status !== 'new') return this.log({ event: 'dm_out_skip', messageId, status: m.status });
    const conv = await this.espo.get(`Conversation/${m.conversationId}`);
    if (!windowOpen(conv.windowExpiresAt)) {
      return void (await this.espo.put(`SocialMessage/${messageId}`, { status: 'failed', error: '24-hour reply window is over' }));
    }
    try {
      const sentMid = await this.meta.sendText(conv.customerId, m.text);
      // KPI "AI replies corrected by a human": the person started from the AI draft; did they change it?
      let aiEdited: boolean | undefined;
      if (m.aiDraftUsed) {
        const original = (await this.espo.list('SocialMessage', { ...eq('conversationId', conv.id, 0), ...eq('direction', 'in', 1), orderBy: 'createdAt', order: 'desc', maxSize: '5', select: 'aiDraft' })).find((x: any) => x.aiDraft)?.aiDraft;
        if (original) aiEdited = original.replace(/\s+/g, ' ').trim() !== String(m.text).replace(/\s+/g, ' ').trim();
      }
      await this.espo.put(`SocialMessage/${messageId}`, { status: 'sent', externalId: sentMid, error: null, ...(aiEdited === undefined ? {} : { aiEdited }) });
      await this.espo.put(`Conversation/${conv.id}`, { status: 'open' });
      // The customer's waiting messages are now answered by a person.
      const waiting = await this.espo.list('SocialMessage', { ...eq('conversationId', conv.id, 0), ...eq('status', 'needs_human', 1), select: 'id' });
      for (const w of waiting) await this.espo.put(`SocialMessage/${w.id}`, { status: 'sent' });
      this.log({ event: 'dm_sent', messageId, conversationId: conv.id });
    } catch (e) {
      this.log({ event: 'dm_out_error', messageId, error: String(e) });
      await this.espo.put(`SocialMessage/${messageId}`, { status: 'failed', error: String(e).replace(/^Error: /, '').slice(0, 250) });
    }
  }
}
