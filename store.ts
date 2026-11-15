// SPDX-License-Identifier: MIT
import { ancestor, commitInfo, filesAt, makeTree, makeCommit, put, peel, validRef, oidOK, treeEntries } from './git.ts';
export class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export const fail = (status: number, message: string): never => { throw new HttpError(status, message); };
export const requireText = (v: any, field: string) => typeof v === 'string' && v.trim() ? v : fail(422, `${field} is required`);
const nodeId = (type: string, id: number) => Buffer.from(`${type}:${id}`).toString('base64');
export class Store {
  repos = new Map<string, any>(); nodes = new Map<string, any>(); nextId = 1; owner: string | null = null;
  now: string; epoch: number; base = '';
  constructor(now: string) { const n = Date.parse(now); this.epoch = Number.isFinite(n) ? Math.floor(n / 1000) : 0; this.now = new Date(this.epoch * 1000).toISOString(); }
  user() { return { login: this.owner ?? 'forge', id: 1, node_id: nodeId('User', 1), type: 'User', name: this.owner ?? 'forge' }; }
  bind(owner: string) {
    if (!this.owner && /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(owner)) this.owner = owner;
    return owner === this.owner;
  }
  repo(owner: string, name: string, nullable = false): any {
    const r = this.repos.get(name);
    // First owner-qualified request binds the initially opaque credential. Never bind on a miss.
    if (r && this.bind(owner)) return r;
    if (nullable) return null; return fail(404, 'Not Found');
  }
  identity(type: string, data: any) { const id = this.nextId++; const o = { ...data, id, node_id: nodeId(type, id), _type: type }; this.nodes.set(o.node_id, o); return o; }
  createRepo(input: any) {
    const name = requireText(input.name, 'name');
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === '.' || name === '..') fail(422, 'Invalid repository name');
    if (input.description !== undefined && typeof input.description !== 'string') fail(422, 'Invalid description');
    if (input.private !== undefined && typeof input.private !== 'boolean') fail(422, 'Invalid private flag');
    if (input.default_branch !== undefined && !validRef(`refs/heads/${input.default_branch}`)) fail(422, 'Invalid default branch');
    if (this.repos.has(name)) fail(422, 'Repository already exists');
    const r = this.identity('Repository', { name, description: input.description ?? '', private: !!input.private, default_branch: input.default_branch ?? 'main', objects: new Map(), refs: new Map(), packCache: new Map(), revision: 0, issues: new Map(), pulls: new Map(), labels: new Map(), comments: new Map(), nextNumber: 1, created_at: this.now, updated_at: this.now });
    this.repos.set(name, r);
    if (input.auto_init) this.writeFile(r, 'README.md', { content: Buffer.from(`# ${name}\n`).toString('base64'), message: 'Initial commit' });
    return r;
  }
  repoView(r: any) { return { id: r.id, node_id: r.node_id, name: r.name, full_name: `${this.user().login}/${r.name}`, owner: this.user(), description: r.description, private: r.private, default_branch: r.default_branch, has_issues: true, archived: false, disabled: false, fork: false, created_at: r.created_at, updated_at: r.updated_at, html_url: `${this.base}/${this.user().login}/${r.name}`, clone_url: `${this.base}/${this.user().login}/${r.name}.git`, permissions: { admin: true, push: true, pull: true } }; }
  removeRepo(r: any) { this.repos.delete(r.name); for (const [id, n] of this.nodes) if (n === r || n._repo === r) this.nodes.delete(id); }
  resolve(r: any, ref?: string) { const name = ref ?? r.default_branch; const id = r.refs.get(name) ?? r.refs.get(`refs/heads/${name}`) ?? r.refs.get(`refs/tags/${name}`) ?? (oidOK(name) && r.objects.has(name) ? name : null); return id; }
  commitView(r: any, id: string) { const c = commitInfo(r.objects.get(id)); return { sha: id, node_id: Buffer.from(`Commit:${id}`).toString('base64'), commit: { message: c.message, tree: { sha: c.tree }, author: { name: this.user().login, email: 'forge@localhost', date: this.now }, committer: { name: this.user().login, email: 'forge@localhost', date: this.now } }, parents: c.parents.map(sha => ({ sha })) }; }
  commits(r: any, ref?: string) {
    const root = this.resolve(r, ref); if (!root) return [];
    const todo = [peel(r.objects, root)], seen = new Set(), out = [];
    while (todo.length) { const id = todo.shift()!; if (seen.has(id)) continue; seen.add(id); const o = r.objects.get(id); if (o?.type !== 'commit') continue; out.push(this.commitView(r, id)); todo.push(...commitInfo(o).parents); }
    return out;
  }
  content(r: any, path: string, ref?: string) {
    const tip = this.resolve(r, ref); if (!tip) fail(404, 'Not Found');
    let id = commitInfo(r.objects.get(peel(r.objects, tip))).tree, mode = '40000';
    if (path) for (const segment of path.split('/')) {
      const o = r.objects.get(id); if (o?.type !== 'tree') fail(404, 'Not Found');
      const e = treeEntries(o.data).find(e => e.name === segment); if (!e) fail(404, 'Not Found'); id = e.oid; mode = e.mode;
    }
    const view = (sha: string, p: string, m: string, full: boolean) => {
      const o = r.objects.get(sha), dir = m === '40000';
      return { name: p.split('/').at(-1) ?? '', path: p, sha, type: dir ? 'dir' : 'file', size: dir ? 0 : o?.data.length ?? 0, ...(full && !dir ? { encoding: 'base64', content: o.data.toString('base64') } : {}) };
    };
    if (mode !== '40000') return view(id, path, mode, true);
    return treeEntries(r.objects.get(id).data).map(e => view(e.oid, path ? `${path}/${e.name}` : e.name, e.mode, false));
  }
  writeFile(r: any, path: string, input: any, remove = false) {
    if (!path || path.split('/').some(s => !s || s === '.' || s === '..' || /[\0\r\n]/.test(s))) fail(422, 'Invalid path');
    const message = requireText(input.message, 'message');
    const branch = input.branch ?? r.default_branch, ref = `refs/heads/${branch}`;
    if (!validRef(ref)) fail(422, 'Invalid branch');
    let parent = r.refs.get(ref);
    if (!parent && r.refs.size) fail(404, 'Branch not found');
    const files = filesAt(r.objects, parent), old = files.get(path);
    if (!old && [...files.keys()].some(p => p.startsWith(path + '/') || path.startsWith(p + '/'))) fail(422, 'File/directory collision');
    if (remove && !old) fail(404, 'Not Found');
    if ((old && old.oid !== input.sha) || (!old && input.sha)) fail(409, 'Content sha does not match');
    let blob: string | null = null;
    if (remove) files.delete(path);
    else {
      if (typeof input.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.content.replace(/\s/g, ''))) fail(422, 'Invalid base64 content');
      blob = put(r.objects, 'blob', Buffer.from(input.content, 'base64'));
      files.set(path, { oid: blob, mode: old?.mode ?? '100644' });
    }
    const tree = makeTree(r.objects, files), sha = makeCommit(r.objects, tree, parent ? [parent] : [], message, this.epoch);
    r.refs.set(ref, sha); r.revision++; r.packCache.clear();
    return { status: old ? 200 : 201, body: { content: remove ? null : { ...this.content(r, path, branch), sha: blob, encoding: 'base64' }, commit: { sha, message, tree: { sha: tree }, parents: parent ? [{ sha: parent }] : [] } } };
  }
  createLabel(r: any, input: any) { const name = requireText(input.name, 'name'); if (r.labels.has(name)) fail(422, 'Label already exists'); const l = this.identity('Label', { name, color: input.color ?? 'ededed', description: input.description ?? '', _repo: r }); r.labels.set(name, l); return this.labelView(l); }
  patchLabel(r: any, l: any, input: any) {
    const name = input.new_name === undefined ? l.name : requireText(input.new_name, 'new_name');
    if (name !== l.name && r.labels.has(name)) fail(422, 'Label already exists');
    if (input.color !== undefined && (typeof input.color !== 'string' || !/^[0-9a-fA-F]{6}$/.test(input.color))) fail(422, 'Invalid label color');
    if (input.description !== undefined && typeof input.description !== 'string') fail(422, 'Invalid description');
    const old = l.name; r.labels.delete(old); Object.assign(l, { name, color: input.color ?? l.color, description: input.description ?? l.description }); r.labels.set(name, l);
    for (const i of r.issues.values()) i.labels = i.labels.map(n => n === old ? name : n);
    return this.labelView(l);
  }
  labelView(l: any) { return { id: l.id, node_id: l.node_id, name: l.name, color: l.color, description: l.description }; }
  labels(r: any, value: any) { if (!Array.isArray(value)) fail(422, 'labels must be an array'); return value.map(x => { const name = typeof x === 'string' ? x : x?.name; if (!r.labels.has(name)) fail(422, 'Unknown label'); return name; }); }
  createIssue(r: any, input: any) {
    const title = requireText(input.title, 'title'), labels = this.labels(r, input.labels ?? []);
    const i = this.identity('Issue', { _repo: r, number: r.nextNumber++, title, body: input.body ?? '', state: 'open', labels, created_at: this.now, updated_at: this.now, closed_at: null, comments: [] }); r.issues.set(i.number, i); return i;
  }
  issueView(i: any) { return { id: i.id, node_id: i.node_id, number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels.map(n => this.labelView(i._repo.labels.get(n))).filter(Boolean), user: this.user(), comments: i.comments.length, created_at: i.created_at, updated_at: i.updated_at, closed_at: i.closed_at, html_url: `${this.base}/${this.user().login}/${i._repo.name}/issues/${i.number}` }; }
  patchIssue(i: any, input: any) {
    const change: any = {};
    if (input.title !== undefined) change.title = requireText(input.title, 'title');
    if (input.body !== undefined) { if (typeof input.body !== 'string') fail(422, 'Invalid body'); change.body = input.body; }
    if (input.labels !== undefined) change.labels = this.labels(i._repo, input.labels);
    if (input.state !== undefined) { if (!['open', 'closed'].includes(input.state)) fail(422, 'Invalid state'); change.state = input.state; change.closed_at = input.state === 'closed' ? this.now : null; }
    Object.assign(i, change, { updated_at: this.now }); return i;
  }
  list(items: Iterable<any>, state = 'open', direction = 'desc') { return [...items].filter(i => state === 'all' || i.state === state).sort((a, b) => direction === 'asc' ? a.number - b.number : b.number - a.number); }
  comment(i: any, input: any) { const body = requireText(input.body, 'body'); const c = this.identity('IssueComment', { _repo: i._repo, _issue: i, body, created_at: this.now, updated_at: this.now }); i.comments.push(c); i._repo.comments.set(c.id, c); return c; }
  commentView(c: any) { return { id: c.id, node_id: c.node_id, body: c.body, user: this.user(), created_at: c.created_at, updated_at: c.updated_at }; }
  createPull(r: any, input: any) {
    const title = requireText(input.title, 'title'), head = requireText(input.head, 'head').replace(`${this.user().login}:`, ''), base = requireText(input.base, 'base');
    if (!r.refs.has(`refs/heads/${head}`) || !r.refs.has(`refs/heads/${base}`) || head === base) fail(422, 'Invalid head or base');
    if ([...r.pulls.values()].some((p: any) => p.head === head && p.base === base && p.state === 'open')) fail(422, 'Pull request already exists');
    const p = this.identity('PullRequest', { _repo: r, number: r.nextNumber++, title, body: input.body ?? '', head, base, state: 'open', merged: false, merge_commit_sha: null, merged_at: null, created_at: this.now, updated_at: this.now, comments: [] }); r.pulls.set(p.number, p); return p;
  }
  mergeBase(r: any, a: string, b: string) {
    const ancestors = new Set<string>(), todo = [a];
    while (todo.length) { const id = todo.shift()!; if (ancestors.has(id)) continue; ancestors.add(id); todo.push(...commitInfo(r.objects.get(id)).parents); }
    const seen = new Set<string>(); todo.push(b);
    while (todo.length) { const id = todo.shift()!; if (ancestors.has(id)) return id; if (seen.has(id)) continue; seen.add(id); todo.push(...commitInfo(r.objects.get(id)).parents); }
    return undefined;
  }
  mergePlan(p: any) {
    const r = p._repo, head = r.refs.get(`refs/heads/${p.head}`), base = r.refs.get(`refs/heads/${p.base}`);
    if (!head || !base) return { conflict: true, files: new Map(), head, base };
    const common = this.mergeBase(r, base, head), original = filesAt(r.objects, common), theirs = filesAt(r.objects, head), ours = filesAt(r.objects, base), merged = new Map(ours); let conflict = false;
    for (const path of new Set([...original.keys(), ...theirs.keys()])) {
      const before = original.get(path), next = theirs.get(path), current = ours.get(path);
      const eq = (a: any, b: any) => a?.oid === b?.oid && a?.mode === b?.mode;
      if (eq(before, next)) continue;
      if (!eq(current, before) && !eq(current, next)) { conflict = true; continue; }
      if (next) merged.set(path, next); else merged.delete(path);
    }
    return { conflict, files: merged, head, base };
  }
  pullView(p: any) { const r = p._repo, plan = this.mergePlan(p); return { id: p.id, node_id: p.node_id, number: p.number, title: p.title, body: p.body, state: p.state, merged: p.merged, mergeable: !plan.conflict, mergeable_state: plan.conflict ? 'dirty' : 'clean', head: { ref: p.head, sha: plan.head, label: `${this.user().login}:${p.head}` }, base: { ref: p.base, sha: plan.base, label: `${this.user().login}:${p.base}` }, merge_commit_sha: p.merge_commit_sha, merged_at: p.merged_at, created_at: p.created_at, updated_at: p.updated_at, user: this.user(), html_url: `${this.base}/${this.user().login}/${r.name}/pull/${p.number}` }; }
  diff(p: any) {
    const r = p._repo, head = this.resolve(r, p.head), base = this.resolve(r, p.base); if (!head || !base) return [];
    const old = filesAt(r.objects, this.mergeBase(r, base, head)), next = filesAt(r.objects, head), out = [];
    for (const path of [...new Set([...old.keys(), ...next.keys()])].sort()) {
      const a = old.get(path), b = next.get(path); if (a?.oid === b?.oid && a?.mode === b?.mode) continue;
      const lines = (e: any) => e ? r.objects.get(e.oid)?.data.toString().split(/\n/).filter((x: string, i: number, all: string[]) => i < all.length - 1 || x !== '') ?? [] : [];
      const left = lines(a), right = lines(b); let prefix = 0, suffix = 0;
      while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
      while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
      const additions = right.length - prefix - suffix, deletions = left.length - prefix - suffix;
      const patch = `@@ -${prefix + 1},${deletions} +${prefix + 1},${additions} @@\n${left.slice(prefix, left.length - suffix).map((l: string) => '-' + l).concat(right.slice(prefix, right.length - suffix).map((l: string) => '+' + l)).join('\n')}`;
      out.push({ filename: path, path, sha: b?.oid ?? a?.oid, status: !a ? 'added' : !b ? 'removed' : 'modified', additions, deletions, changes: additions + deletions, patch });
    }
    return out;
  }
  merge(p: any, input: any = {}) {
    if (p.merged || p.state !== 'open') fail(405, 'Pull request is not open');
    if (input.merge_method && input.merge_method !== 'squash') fail(422, 'Only squash merges are supported');
    const plan = this.mergePlan(p); if (plan.conflict) fail(405, 'Pull request has conflicts');
    if (input.sha && input.sha !== plan.head) fail(409, 'Head sha does not match');
    const r = p._repo, tree = makeTree(r.objects, plan.files), sha = makeCommit(r.objects, tree, [plan.base], input.commit_title ?? `${p.title} (#${p.number})`, this.epoch);
    r.refs.set(`refs/heads/${p.base}`, sha); r.revision++; r.packCache.clear(); p.merged = true; p.state = 'closed'; p.merged_at = this.now; p.merge_commit_sha = sha;
    return { sha, merged: true, message: 'Pull request successfully merged' };
  }
}
export function rest(store: Store, method: string, u: URL, b: any) {
  const path = decodeURIComponent(u.pathname).replace(/^\/api\/v3/, '').replace(/\/$/, '') || '/', q = u.searchParams;
  const ok = (body: any, status = 200, headers: any = {}) => ({ status, body, headers });
  const page = (items: any[]) => {
    const size = Math.min(100, Math.max(1, Number(q.get('per_page')) || 30)), num = Math.max(1, Number(q.get('page')) || 1), start = (num - 1) * size;
    const headers: any = {}; if (start + size < items.length) { const next = new URL(u); next.searchParams.set('per_page', String(size)); next.searchParams.set('page', String(num + 1)); headers.link = `<${next}>; rel="next"`; }
    return ok(items.slice(start, start + size), 200, headers);
  };
  if (path === '/' && method === 'GET') return ok({ current_user_url: `${store.base}/api/v3/user`, repository_url: `${store.base}/api/v3/repos/{owner}/{repo}` }, 200, { 'x-oauth-scopes': 'repo, read:org' });
  if (path === '/meta' && method === 'GET') return ok({ installed_version: 'harbor-forge-1' });
  if (path === '/user' && method === 'GET') return ok(store.user());
  if (path === '/user/repos') {
    if (method === 'POST') return ok(store.repoView(store.createRepo(b)), 201);
    if (method === 'GET') return page([...store.repos.values()].map(r => store.repoView(r)));
  }
  const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path); if (!match) fail(404, 'Not Found');
  const r = store.repo(match[1], match[2]), route = match[3] ?? '';
  if (!route) {
    if (method === 'GET') return ok(store.repoView(r));
    if (method === 'DELETE') { store.removeRepo(r); return ok(null, 204); }
    if (method === 'PATCH') {
      if (b.description !== undefined && typeof b.description !== 'string') fail(422, 'Invalid description');
      if (b.private !== undefined && typeof b.private !== 'boolean') fail(422, 'Invalid private flag');
      if (b.default_branch !== undefined && (!validRef(`refs/heads/${b.default_branch}`) || !r.refs.has(`refs/heads/${b.default_branch}`))) fail(422, 'Unknown default branch');
      for (const k of ['description', 'private', 'default_branch']) if (b[k] !== undefined) r[k] = b[k]; return ok(store.repoView(r));
    }
  }
  if (route === 'branches' && method === 'GET') return page([...r.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha }, protected: false })));
  if (route.startsWith('branches/') && method === 'GET') { const name = route.slice(9), sha = r.refs.get(`refs/heads/${name}`); if (!sha) fail(404, 'Not Found'); return ok({ name, commit: { sha }, protected: false }); }
  if (route === 'git/refs' && method === 'POST') { if (!validRef(b.ref) || !oidOK(b.sha) || !r.objects.has(b.sha)) fail(422, 'Invalid ref or object'); if (r.refs.has(b.ref)) fail(422, 'Reference already exists'); if (b.ref.startsWith('refs/heads/') && r.objects.get(b.sha).type !== 'commit') fail(422, 'Branch requires commit'); r.refs.set(b.ref, b.sha); r.revision++; r.packCache.clear(); return ok({ ref: b.ref, object: { sha: b.sha, type: r.objects.get(b.sha).type } }, 201); }
  if (route.startsWith('git/refs/') || route.startsWith('git/ref/')) {
    const ref = 'refs/' + route.replace(/^git\/refs?\//, ''), sha = r.refs.get(ref); if (!sha) fail(404, 'Not Found');
    if (method === 'GET') return ok({ ref, object: { sha, type: r.objects.get(sha).type } });
    if (method === 'DELETE') { r.refs.delete(ref); r.revision++; r.packCache.clear(); return ok(null, 204); }
    if (method === 'PATCH') { if (!oidOK(b.sha) || !r.objects.has(b.sha)) fail(422, 'Invalid sha'); if (!ancestor(r.objects, sha, b.sha)) fail(422, 'non-fast-forward'); r.refs.set(ref, b.sha); r.revision++; r.packCache.clear(); return ok({ ref, object: { sha: b.sha } }); }
  }
  if (route === 'commits' && method === 'GET') return page(store.commits(r, q.get('sha') ?? undefined));
  if (route.startsWith('commits/') && method === 'GET') { const id = store.resolve(r, route.slice(8)); if (!id) fail(404, 'Not Found'); return ok(store.commitView(r, id)); }
  if (route === 'contents' || route.startsWith('contents/')) {
    const path = route.slice(9);
    if (method === 'GET') return ok(store.content(r, path, q.get('ref') ?? undefined));
    if (method === 'PUT' || method === 'DELETE') { const result = store.writeFile(r, path, b, method === 'DELETE'); return ok(result.body, method === 'DELETE' ? 200 : result.status); }
  }
  if (route === 'labels') { if (method === 'POST') return ok(store.createLabel(r, b), 201); if (method === 'GET') return page([...r.labels.values()].map(l => store.labelView(l))); }
  if (route.startsWith('labels/')) { const name = route.slice(7), l = r.labels.get(name); if (!l) fail(404, 'Not Found'); if (method === 'GET') return ok(store.labelView(l)); if (method === 'PATCH') return ok(store.patchLabel(r, l, b)); if (method === 'DELETE') { r.labels.delete(name); store.nodes.delete(l.node_id); for (const i of r.issues.values()) i.labels = i.labels.filter(n => n !== name); return ok(null, 204); } }
  if (route === 'issues') { if (method === 'POST') return ok(store.issueView(store.createIssue(r, b)), 201); if (method === 'GET') return page(store.list(r.issues.values(), q.get('state') ?? 'open', q.get('direction') ?? 'desc').map(i => store.issueView(i))); }
  const issue = /^issues\/(\d+)(?:\/(comments|labels))?$/.exec(route);
  if (issue) {
    const i = r.issues.get(Number(issue[1])); if (!i) fail(404, 'Not Found');
    if (issue[2] === 'comments') { if (method === 'POST') return ok(store.commentView(store.comment(i, b)), 201); if (method === 'GET') return page(i.comments.map(c => store.commentView(c))); }
    else if (!issue[2]) { if (method === 'GET') return ok(store.issueView(i)); if (method === 'PATCH') return ok(store.issueView(store.patchIssue(i, b))); }
    else if (issue[2] === 'labels') { if (method === 'POST' || method === 'PUT') { const names = store.labels(r, b.labels ?? b); i.labels = method === 'PUT' ? names : [...new Set([...i.labels, ...names])]; return ok(i.labels.map(n => store.labelView(r.labels.get(n)))); } if (method === 'GET') return ok(i.labels.map(n => store.labelView(r.labels.get(n)))); }
  }
  const comment = /^issues\/comments\/(\d+)$/.exec(route);
  if (comment) { const c = r.comments.get(Number(comment[1])); if (!c) fail(404, 'Not Found'); if (method === 'GET') return ok(store.commentView(c)); if (method === 'PATCH') { c.body = requireText(b.body, 'body'); return ok(store.commentView(c)); } if (method === 'DELETE') { r.comments.delete(c.id); c._issue.comments = c._issue.comments.filter(x => x !== c); store.nodes.delete(c.node_id); return ok(null, 204); } }
  if (route === 'pulls') { if (method === 'POST') return ok(store.pullView(store.createPull(r, b)), 201); if (method === 'GET') return page(store.list(r.pulls.values(), q.get('state') ?? 'open', q.get('direction') ?? 'desc').map(p => store.pullView(p))); }
  const pull = /^pulls\/(\d+)(?:\/(files|merge|commits))?$/.exec(route);
  if (pull) {
    const p = r.pulls.get(Number(pull[1])); if (!p) fail(404, 'Not Found');
    if (pull[2] === 'files' && method === 'GET') return page(store.diff(p));
    if (pull[2] === 'merge') { if (method === 'PUT') return ok(store.merge(p, b)); if (method === 'GET') return p.merged ? ok(null, 204) : fail(404, 'Not merged'); }
    if (pull[2] === 'commits' && method === 'GET') return page(store.commits(r, p.head).filter(c => !ancestor(r.objects, c.sha, store.resolve(r, p.base))));
    if (!pull[2]) {
      if (method === 'GET') return ok(store.pullView(p));
      if (method === 'PATCH') {
        const change: any = {};
        if (b.title !== undefined) change.title = requireText(b.title, 'title');
        if (b.body !== undefined) { if (typeof b.body !== 'string') fail(422, 'Invalid body'); change.body = b.body; }
        if (b.state !== undefined) { if (!['open', 'closed'].includes(b.state) || p.merged) fail(422, 'Invalid state'); change.state = b.state; }
        if (b.base !== undefined) { if (!r.refs.has(`refs/heads/${b.base}`) || b.base === p.head) fail(422, 'Invalid base'); change.base = b.base; }
        Object.assign(p, change); return ok(store.pullView(p));
      }
    }
  }
  fail(404, 'Not Found');
}
