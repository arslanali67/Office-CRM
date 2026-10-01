// Meta (Facebook Messenger + Instagram) webhook parsing/verification and Graph API client.
import { createHmac, timingSafeEqual } from 'node:crypto';

export type Channel = 'facebook' | 'instagram';

export interface InboundDm {
  channel: Channel;
  customerId: string;
  mid: string;
  text: string;
  timestamp: number; // ms
  isEcho: boolean;
  hasAttachment: boolean;
}

/** Meta signs the raw body: `X-Hub-Signature-256: sha256=<hmac-sha256-hex(body, app secret)>`. */
export function validMetaSignature(raw: string, header: string | undefined, appSecret: string): boolean {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  const given = header.slice('sha256='.length);
  const want = createHmac('sha256', appSecret).update(raw).digest('hex');
  return given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

/** Flattens a Meta webhook body. Events without a message (delivery, read, ...) are dropped. */
export function parseMetaPayload(body: any): InboundDm[] {
  const channel: Channel | null = body?.object === 'page' ? 'facebook' : body?.object === 'instagram' ? 'instagram' : null;
  if (!channel || !Array.isArray(body.entry)) return [];
  const out: InboundDm[] = [];
  for (const entry of body.entry) {
    for (const ev of entry?.messaging ?? []) {
      const m = ev?.message;
      if (!m?.mid) continue;
      const isEcho = m.is_echo === true;
      const customerId = String(isEcho ? ev.recipient?.id ?? '' : ev.sender?.id ?? '');
      if (!customerId) continue;
      out.push({
        channel, customerId, mid: String(m.mid), text: typeof m.text === 'string' ? m.text : '',
        timestamp: Number(ev.timestamp) || Date.now(), isEcho, hasAttachment: Array.isArray(m.attachments) && m.attachments.length > 0,
      });
    }
  }
  return out;
}

/** Meta only allows a reply within 24 hours of the customer's last message. `until` is an EspoCRM UTC datetime. */
export function windowOpen(until: string | null | undefined, now = Date.now()): boolean {
  if (!until) return false;
  const t = Date.parse(until.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) && t > now;
}

export const toEspoDate = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

export class Meta {
  private graph: string;
  private token: string;

  constructor(graphUrl: string, pageToken: string) {
    this.graph = graphUrl.replace(/\/$/, '');
    this.token = pageToken;
  }

  /** Sends a text through the Send API; returns Meta's message id. Throws with Meta's error text. */
  async sendText(recipientId: string, text: string): Promise<string> {
    const res = await fetch(`${this.graph}/me/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text } }),
      signal: AbortSignal.timeout(20_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.message_id) throw new Error(`Meta ${res.status}: ${data?.error?.message ?? 'no message_id'}`);
    return String(data.message_id);
  }

  /** Customer display name; undefined when Meta does not give one (never fatal). */
  async profileName(id: string, channel: Channel): Promise<string | undefined> {
    try {
      const fields = channel === 'instagram' ? 'name,username' : 'name';
      const res = await fetch(`${this.graph}/${encodeURIComponent(id)}?fields=${fields}`, {
        headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return undefined;
      const d: any = await res.json();
      return (d.name || d.username || '').trim() || undefined;
    } catch {
      return undefined;
    }
  }
}
