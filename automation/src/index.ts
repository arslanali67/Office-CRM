import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Espo } from './espo.ts';
import { EmailProcessor } from './email.ts';
import { ProposalProcessor } from './proposals.ts';
import { DmProcessor } from './dm.ts';
import { Meta, parseMetaPayload, validMetaSignature } from './meta.ts';
import { startReportScheduler } from './reports.ts';

const {
  ESPO_URL = 'http://espocrm', ESPO_API_KEY = '', PORT = '3000',
  WEBHOOK_SECRET = '', WEBHOOK_SECRET_BRIEF = '', WEBHOOK_SECRET_SOCIAL = '',
  META_APP_SECRET = '', META_VERIFY_TOKEN = '', META_PAGE_TOKEN = '', GRAPH_URL = 'https://graph.facebook.com/v21.0',
} = process.env;
const log = (o: object) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

/** EspoCRM signs the raw body: `Signature: base64("<webhookId>:<hmac-sha256-hex(body, secret)>")`. */
export function validSignature(raw: string, header: string | undefined, secret: string): boolean {
  if (!secret || !header) return false;
  const given = Buffer.from(header, 'base64').toString().split(':')[1] ?? '';
  const want = createHmac('sha256', secret).update(raw).digest('hex');
  return given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

if (import.meta.main) {
  const espo = new Espo(ESPO_URL, ESPO_API_KEY);
  const emails = new EmailProcessor(espo, log);
  const proposals = new ProposalProcessor(espo, log);
  const dms = new DmProcessor(espo, new Meta(GRAPH_URL, META_PAGE_TOKEN), log);
  startReportScheduler(espo, log);

  // Separate serial queues: one email / one DM at a time (no races, gentle on the AI rate limit),
  // and a long proposal run must not block incoming messages.
  const queue = () => { let c: Promise<unknown> = Promise.resolve(); return (job: () => Promise<unknown>, what: object) => { c = c.then(job).catch(e => log({ event: 'error', ...what, error: String(e) })); }; };
  const emailQ = queue(), briefQ = queue(), dmQ = queue();

  const readBody = async (req: import('node:http').IncomingMessage): Promise<string | null> => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) return null;
    }
    return raw;
  };

  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/health') return void res.end('ok');

    // Meta subscription handshake
    if (req.method === 'GET' && url.pathname === '/webhooks/meta') {
      const ok = META_VERIFY_TOKEN && url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === META_VERIFY_TOKEN;
      return void (ok ? res.writeHead(200).end(url.searchParams.get('hub.challenge') ?? '') : res.writeHead(403).end());
    }

    const route = req.method === 'POST' ? url.pathname : '';
    if (!['/webhooks/espo', '/webhooks/proposal-brief', '/webhooks/social-message', '/webhooks/meta'].includes(route)) return void res.writeHead(404).end();

    const raw = await readBody(req);
    if (raw === null) return void res.writeHead(413).end();

    if (route === '/webhooks/meta') {
      if (!validMetaSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, META_APP_SECRET)) {
        log({ event: 'bad_signature', route });
        return void res.writeHead(401).end();
      }
      res.writeHead(200).end('EVENT_RECEIVED'); // Meta needs a fast 200; the work happens in the background
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return; }
      for (const dm of parseMetaPayload(body)) dmQ(() => dms.handleInbound(dm), { mid: dm.mid });
      return;
    }

    const secret = route === '/webhooks/proposal-brief' ? WEBHOOK_SECRET_BRIEF : route === '/webhooks/social-message' ? WEBHOOK_SECRET_SOCIAL : WEBHOOK_SECRET;
    if (!validSignature(raw, req.headers.signature as string | undefined, secret)) {
      log({ event: 'bad_signature', route });
      return void res.writeHead(401).end();
    }
    res.writeHead(200).end(); // answer immediately, work in the background

    let items: { id?: string }[] = [];
    try { items = JSON.parse(raw); } catch { return; }
    for (const { id } of items) {
      if (!id) continue;
      if (route === '/webhooks/proposal-brief') briefQ(() => proposals.handle(id), { id });
      else if (route === '/webhooks/social-message') dmQ(() => dms.handleOutbound(id), { id });
      else emailQ(() => emails.handle(id), { id });
    }
  }).listen(Number(PORT), () => log({ event: 'listening', port: PORT }));
}
