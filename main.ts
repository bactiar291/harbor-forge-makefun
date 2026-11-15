// SPDX-License-Identifier: MIT
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { Store, HttpError, rest } from './store.ts';
import { graphql } from './graphql.ts';
import { gitService } from './git.ts';
const token = process.env.MAKEFUN_SHOP_TOKEN;
if (!token) throw new Error('MAKEFUN_SHOP_TOKEN is required');
const secret = Buffer.from(`Bearer ${token}`);
const store = new Store(process.env.MAKEFUN_TRIAL_NOW ?? '1970-01-01T00:00:00Z');
const definitions: any[] = [
  ['create_repo', 'Create a repository owned by the authenticated user.', ['name'], { name: 'string', description: 'string', private: 'boolean' }],
  ['get_repo', 'Read repository metadata and its stable identity.', ['owner', 'repo'], { owner: 'string', repo: 'string' }],
  ['create_issue', 'Create an open issue in an existing repository.', ['owner', 'repo', 'title'], { owner: 'string', repo: 'string', title: 'string', body: 'string' }],
  ['list_issues', 'List repository issues filtered by open, closed, or all state.', ['owner', 'repo'], { owner: 'string', repo: 'string', state: 'string' }],
  ['create_pull_request', 'Open a pull request between two existing branches.', ['owner', 'repo', 'title', 'head', 'base'], { owner: 'string', repo: 'string', title: 'string', head: 'string', base: 'string', body: 'string' }],
  ['merge_pull_request', 'Squash merge a nonconflicting open pull request.', ['owner', 'repo', 'pull_number'], { owner: 'string', repo: 'string', pull_number: 'integer' }],
  ['get_file_contents', 'Read a file as base64 or list a directory at a Git ref.', ['owner', 'repo', 'path'], { owner: 'string', repo: 'string', path: 'string', ref: 'string' }],
  ['add_issue_comment', 'Add a comment to an existing issue.', ['owner', 'repo', 'issue_number', 'body'], { owner: 'string', repo: 'string', issue_number: 'integer', body: 'string' }]
];
const tools = definitions.map(([name, description, required, properties]) => ({ name, description, inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(properties).map(([name, type]) => [name, { type, description: name.replaceAll('_', ' ') }])), required, additionalProperties: false } }));
function mcp(body: any): any {
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: body?.id ?? null, error: { code, message } });
  if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return error(-32600, 'Invalid Request');
  const reply = (result: any) => ({ jsonrpc: '2.0', id: body.id, result });
  if (body.id === undefined && body.method.startsWith('notifications/')) return null;
  if (body.method === 'server/discover') return reply({ supportedVersions: ['2026-07-28', '2025-11-25'], serverInfo: { name: 'Harbor Forge', version: '1.0.0' }, capabilities: { tools: { listChanged: false } } });
  if (body.method === 'initialize') return reply({ protocolVersion: body.params?.protocolVersion === '2025-11-25' ? '2025-11-25' : '2026-07-28', serverInfo: { name: 'Harbor Forge', version: '1.0.0' }, capabilities: { tools: { listChanged: false } } });
  if (body.method === 'ping') return reply({});
  if (body.method === 'tools/list') return reply({ tools });
  if (body.method !== 'tools/call') return error(-32601, 'Method not found');
  const tool = tools.find(t => t.name === body.params?.name); if (!tool) return error(-32602, 'Unknown tool');
  const a = body.params.arguments;
  if (!a || typeof a !== 'object' || Array.isArray(a) || tool.inputSchema.required.some(k => a[k] === undefined)) return error(-32602, 'Missing required arguments');
  for (const [k, v] of Object.entries(a)) {
    const prop: any = tool.inputSchema.properties[k];
    if (!prop || (prop.type === 'integer' ? !Number.isSafeInteger(v) || Number(v) < 1 : typeof v !== prop.type)) return error(-32602, `Invalid argument ${k}`);
  }
  try {
    let result: any;
    if (tool.name === 'create_repo') result = store.repoView(store.createRepo(a));
    else {
      const r = store.repo(a.owner, a.repo);
      switch (tool.name) {
        case 'get_repo': result = store.repoView(r); break;
        case 'create_issue': result = store.issueView(store.createIssue(r, a)); break;
        case 'list_issues': if (a.state && !['open', 'closed', 'all'].includes(a.state)) return error(-32602, 'Invalid state'); result = store.list(r.issues.values(), a.state ?? 'open').map(i => store.issueView(i)); break;
        case 'create_pull_request': result = store.pullView(store.createPull(r, a)); break;
        case 'merge_pull_request': { const p = r.pulls.get(a.pull_number); if (!p) throw new HttpError(404, 'Pull request not found'); result = store.merge(p); break; }
        case 'get_file_contents': result = store.content(r, a.path, a.ref); break;
        case 'add_issue_comment': { const i = r.issues.get(a.issue_number); if (!i) throw new HttpError(404, 'Issue not found'); result = store.commentView(store.comment(i, a)); break; }
      }
    }
    return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: Array.isArray(result) ? { items: result } : result, isError: false });
  } catch (e: any) { return reply({ isError: true, content: [{ type: 'text', text: e.message }] }); }
}
let requestId = 0;
function send(res: any, status: number, value: any, headers: any = {}) {
  const body = status === 204 || status === 202 && value === null ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'x-github-request-id': (++requestId).toString(16).padStart(12, '0'), 'cache-control': 'no-store', ...headers }); res.end(body);
}
async function readBody(req: any, limit: number) { const chunks: Buffer[] = []; let n = 0; for await (const chunk of req) { n += chunk.length; if (n > limit) throw new HttpError(413, 'Request body too large'); chunks.push(chunk); } return Buffer.concat(chunks); }
const server = createServer({ requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 16384 }, async (req, res) => {
  try {
    const host = req.headers.host;
    if (!host || !/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::[0-9]+)?$/.test(host)) throw new HttpError(400, 'Invalid Host');
    const u = new URL(req.url ?? '/', `http://${host}`);
    if (u.origin !== `http://${host}`) throw new HttpError(400, 'Invalid request target');
    if (u.pathname === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true });
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) return send(res, 401, { message: 'Bad credentials' });
    if (!store.base) store.base = u.origin;
    const git = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(u.pathname);
    if (git) {
      const r = store.repo(decodeURIComponent(git[1]), decodeURIComponent(git[2]));
      const advertise = git[3] === 'info/refs', service = advertise ? u.searchParams.get('service') : git[3];
      if (!['git-upload-pack', 'git-receive-pack'].includes(service ?? '') || req.method !== (advertise ? 'GET' : 'POST')) throw new HttpError(404, 'Not Found');
      const body = advertise ? Buffer.alloc(0) : await readBody(req, 64 * 1024 * 1024);
      try { return send(res, 200, gitService(r, service!, advertise, req.headers['git-protocol'] === 'version=2', body), { 'content-type': `application/x-${service}-${advertise ? 'advertisement' : 'result'}` }); }
      catch (e: any) { throw new HttpError(400, e.message); }
    }
    let body: any = {};
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
      const raw = await readBody(req, 8 * 1024 * 1024);
      if (raw.length) {
        try { body = JSON.parse(raw.toString()); }
        catch { return send(res, 400, u.pathname === '/mcp' ? { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } : { message: 'Invalid JSON' }); }
      }
    }
    if (u.pathname === '/api/graphql' && req.method === 'POST') return send(res, 200, graphql(store, body));
    if (u.pathname === '/mcp') {
      if (req.method === 'POST') { const result = mcp(body); return send(res, result === null ? 202 : 200, result); }
      if (req.method === 'DELETE') return send(res, 204, null);
      return send(res, 405, { message: 'Use POST for JSON-RPC' }, { allow: 'POST, DELETE' });
    }
    if (u.pathname === '/api/v3' || u.pathname.startsWith('/api/v3/')) {
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected JSON object');
      const result = rest(store, req.method ?? 'GET', u, body); return send(res, result.status, result.body, result.headers);
    }
    send(res, 404, { message: 'Not Found' });
  } catch (e: any) { if (!res.headersSent) send(res, e instanceof HttpError ? e.status : e instanceof URIError ? 400 : 500, { message: e instanceof HttpError || e instanceof URIError ? e.message : 'Internal server error' }); else res.destroy(); if (!(e instanceof HttpError) && !(e instanceof URIError)) console.error(e.stack); }
});
server.maxRequestsPerSocket = 0;
server.on('clientError', (_e, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
const envUrl = process.env.MAKEFUN_ENV_URL;
if (!envUrl) throw new Error('MAKEFUN_ENV_URL is required');
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, process.env.MAKEFUN_BIND_HOST ?? '0.0.0.0', resolve); });
const address: any = server.address();
console.log(`Harbor Forge listening on ${address.port}`);
let stopping = false, closing: Promise<void> | undefined;
const lifecycle = new AbortController();
async function shutdown() { stopping = true; lifecycle.abort(); closing ??= new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); await closing; }
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
try {
  const registered = await fetch(new URL('/register', envUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: address.port }), signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!registered.ok) throw new Error(`Registration returned ${registered.status}`); await registered.arrayBuffer();
  while (!stopping) {
    const response = await fetch(new URL('/done', envUrl), { signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(30000)]), redirect: 'error' });
    if (!response.ok) throw new Error(`Done returned ${response.status}`);
    const status: any = await response.json(); if (status.done === true) break; await pause(250, undefined, { signal: lifecycle.signal });
  }
  await shutdown();
} catch (e: any) { if (!stopping) { console.error(e.message); process.exitCode = 1; } await shutdown(); }
