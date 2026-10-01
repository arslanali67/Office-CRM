// Local stand-in for Meta's Graph API (Send API + profile lookup), used by docker-compose.local.yml and scripts/test-m5.mjs.
// Control endpoints: GET /_sent, POST /_reset, POST /_profile {id, name}.
import { createServer } from 'node:http';

const TOKEN = process.env.MOCK_PAGE_TOKEN ?? 'local-page-token';
let sent: { recipient: string; text: string; token: string }[] = [];
const profiles = new Map<string, string>();
let n = 0;
const BOOT = Date.now().toString(36); // ids stay unique across restarts, like Meta's

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const send = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  let raw = '';
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};

  if (url.pathname === '/_sent') return send(200, sent);
  if (url.pathname === '/_reset') { sent = []; profiles.clear(); return send(200, {}); }
  if (url.pathname === '/_profile') { profiles.set(body.id, body.name); return send(200, {}); }

  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (token !== TOKEN) return send(401, { error: { message: 'Invalid OAuth access token.', code: 190 } });

  if (req.method === 'POST' && url.pathname.endsWith('/me/messages')) {
    const to = String(body.recipient?.id ?? '');
    if (to.startsWith('fail')) return send(400, { error: { message: '(#10) This message is sent outside of allowed window.', code: 10 } });
    sent.push({ recipient: to, text: body.message?.text, token });
    return send(200, { recipient_id: to, message_id: `mid.mock${BOOT}_${++n}` });
  }
  const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
  if (req.method === 'GET' && id) {
    if (id.startsWith('noprofile')) return send(400, { error: { message: 'Unsupported get request.', code: 100 } });
    return send(200, { id, name: profiles.get(id) ?? `Test User ${id}` });
  }
  send(404, {});
}).listen(4010, () => console.log('mock graph on 4010'));
