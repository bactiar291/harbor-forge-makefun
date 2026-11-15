// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
export const ZERO = '0'.repeat(40);
export const oidOK = (s: any) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
export type Obj = { type: string; data: Buffer; packed?: Buffer };
export const digest = (b: Buffer) => createHash('sha1').update(b).digest();
export function hash(type: string, data: Buffer) { return createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex'); }
export function put(objects: Map<string, Obj>, type: string, value: Buffer | string) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const id = hash(type, data);
  if (!objects.has(id)) objects.set(id, { type, data });
  return id;
}
export function commitInfo(o: Obj) {
  if (o?.type !== 'commit') throw new Error('Expected commit');
  const text = o.data.toString(), split = text.indexOf('\n\n');
  const lines = text.slice(0, split).split('\n');
  return { tree: lines.find(x => x.startsWith('tree '))?.slice(5) || '', parents: lines.filter(x => x.startsWith('parent ')).map(x => x.slice(7)), message: text.slice(split + 2).replace(/\n$/, '') };
}
export function treeEntries(data: Buffer) {
  const out: { mode: string; name: string; oid: string }[] = [];
  for (let p = 0; p < data.length;) {
    const sp = data.indexOf(32, p), nul = data.indexOf(0, sp + 1);
    if (sp < p || nul < sp || nul + 21 > data.length) throw new Error('Malformed tree');
    const mode = data.subarray(p, sp).toString(), name = data.subarray(sp + 1, nul).toString();
    if (!/^(40000|100644|100755|120000|160000)$/.test(mode) || !name || name.includes('/') || name === '.' || name === '..') throw new Error('Invalid tree entry');
    out.push({ mode, name, oid: data.subarray(nul + 1, nul + 21).toString('hex') }); p = nul + 21;
  }
  return out;
}
export function references(o: Obj) {
  if (o.type === 'commit') { const c = commitInfo(o); return [c.tree, ...c.parents]; }
  if (o.type === 'tree') return treeEntries(o.data).filter(e => e.mode !== '160000').map(e => e.oid);
  if (o.type === 'tag') { const id = /^object ([0-9a-f]{40})\n/.exec(o.data.toString())?.[1]; if (!id) throw new Error('Malformed tag'); return [id]; }
  return [];
}
export function peel(objects: Map<string, Obj>, id: string) {
  const seen = new Set();
  while (objects.get(id)?.type === 'tag') { if (seen.has(id)) throw new Error('Tag cycle'); seen.add(id); id = references(objects.get(id)!)[0]; }
  return id;
}
export function ancestor(objects: Map<string, Obj>, older: string, newer: string) {
  const todo = [newer], seen = new Set<string>();
  while (todo.length) { const id = todo.pop()!; if (id === older) return true; if (seen.has(id)) continue; seen.add(id); const o = objects.get(id); if (o?.type === 'commit') todo.push(...commitInfo(o).parents); }
  return false;
}
export function reachable(objects: Map<string, Obj>, roots: string[], depth = Infinity, stops = new Set<string>()) {
  const ids = new Set<string>(), shallow = new Set<string>(), visited = new Map<string, number>();
  const todo: [string, number][] = roots.map(id => [id, 1]);
  while (todo.length) {
    const [id, level] = todo.pop()!;
    if ((visited.get(id) ?? Infinity) <= level) continue;
    visited.set(id, level);
    const o = objects.get(id); if (!o) throw new Error(`Missing object ${id}`);
    ids.add(id);
    if (o.type === 'commit') {
      const c = commitInfo(o); todo.push([c.tree, level]);
      if (level >= depth || stops.has(id)) { if (c.parents.length) shallow.add(id); }
      else for (const p of c.parents) todo.push([p, level + 1]);
    } else for (const child of references(o)) todo.push([child, level]);
    if (ids.size > 200000) throw new Error('Object traversal limit');
  }
  return { ids, shallow };
}
// Validate closure once per immutable object, including the types of all links.
// A failed validation never marks a partially checked graph as trusted.
export function validateGraph(objects: any, root: string, trusted: Set<string>) {
  const checked = new Set<string>(), todo = [root];
  while (todo.length) {
    const id = todo.pop()!;
    if (trusted.has(id) || checked.has(id)) continue;
    const o = objects.get(id); if (!o) throw new Error('Missing object');
    const need = (child: string, type?: string) => {
      if (!oidOK(child) || !objects.has(child) || type && objects.get(child).type !== type) throw new Error('Invalid object link');
      todo.push(child);
    };
    if (o.type === 'commit') {
      const c = commitInfo(o); need(c.tree, 'tree'); for (const p of c.parents) need(p, 'commit');
      const text = o.data.toString();
      if (!/^tree [0-9a-f]{40}\n/.test(text) || !/^author .+ \d+ [+-]\d{4}$/m.test(text) || !/^committer .+ \d+ [+-]\d{4}$/m.test(text) || !text.includes('\n\n')) throw new Error('Malformed commit');
    } else if (o.type === 'tree') {
      const names = new Set();
      for (const e of treeEntries(o.data)) { if (names.has(e.name)) throw new Error('Duplicate tree entry'); names.add(e.name); if (e.mode !== '160000') need(e.oid, e.mode === '40000' ? 'tree' : 'blob'); }
    } else if (o.type === 'tag') {
      const text = o.data.toString(), target = /^object ([0-9a-f]{40})\n/.exec(text)?.[1], type = /^type (commit|tree|blob|tag)$/m.exec(text)?.[1];
      if (!target || !type || !/^tag .+$/m.test(text) || !text.includes('\n\n')) throw new Error('Malformed tag'); need(target, type);
    } else if (o.type !== 'blob') throw new Error('Invalid object type');
    checked.add(id); if (checked.size > 200000) throw new Error('Object traversal limit');
  }
  for (const id of checked) trusted.add(id);
}
export function filesAt(objects: Map<string, Obj>, tip?: string) {
  const files = new Map<string, { oid: string; mode: string }>();
  if (!tip) return files;
  const root = commitInfo(objects.get(peel(objects, tip))!).tree;
  const walk = (id: string, prefix: string, depth: number) => {
    if (depth > 100) throw new Error('Tree depth limit');
    const o = objects.get(id); if (o?.type !== 'tree') throw new Error('Missing tree');
    for (const e of treeEntries(o.data)) { const path = prefix + e.name; if (e.mode === '40000') walk(e.oid, path + '/', depth + 1); else files.set(path, { oid: e.oid, mode: e.mode }); }
  };
  walk(root, '', 0); return files;
}
export function makeTree(objects: Map<string, Obj>, files: Map<string, { oid: string; mode: string }>) {
  const root = new Map();
  for (const [path, entry] of files) {
    const parts = path.split('/'); let node = root;
    for (const part of parts.slice(0, -1)) { if (!node.has(part)) node.set(part, new Map()); if (!(node.get(part) instanceof Map)) throw new Error('File/directory collision'); node = node.get(part); }
    if (node.get(parts.at(-1)) instanceof Map) throw new Error('File/directory collision');
    node.set(parts.at(-1), entry);
  }
  const build = (node: Map<string, any>): string => {
    const entries = [...node].map(([name, value]) => ({ name, mode: value instanceof Map ? '40000' : value.mode, oid: value instanceof Map ? build(value) : value.oid }));
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
    return put(objects, 'tree', Buffer.concat(entries.map(e => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex')]))));
  };
  return build(root);
}
export function makeCommit(objects: Map<string, Obj>, tree: string, parents: string[], message: string, epoch: number, author = 'Harbor Forge <forge@localhost>') {
  return put(objects, 'commit', `tree ${tree}\n${parents.map(p => `parent ${p}\n`).join('')}author ${author} ${epoch} +0000\ncommitter ${author} ${epoch} +0000\n\n${message.replace(/\n$/, '')}\n`);
}
const types = ['', 'commit', 'tree', 'blob', 'tag'];
function packHeader(type: number, size: number) {
  const out = []; let n = Math.floor(size / 16); out.push((type << 4) | (size & 15) | (n ? 128 : 0));
  while (n) { const v = n % 128; n = Math.floor(n / 128); out.push(v | (n ? 128 : 0)); }
  return Buffer.from(out);
}
export function pack(objects: Map<string, Obj>, ids: Iterable<string>) {
  const list = [...ids], h = Buffer.alloc(12); h.write('PACK'); h.writeUInt32BE(2, 4); h.writeUInt32BE(list.length, 8);
  const parts = [h];
  for (const id of list) {
    const o = objects.get(id)!;
    o.packed ??= Buffer.concat([packHeader(types.indexOf(o.type), o.data.length), deflateSync(o.data, { level: 1 })]);
    parts.push(o.packed);
  }
  const data = Buffer.concat(parts); return Buffer.concat([data, digest(data)]);
}
function delta(base: Buffer, program: Buffer) {
  let p = 0;
  const byte = () => { if (p >= program.length) throw new Error('Truncated delta'); return program[p++]; };
  const variable = () => { let n = 0, shift = 0, b; do { b = byte(); n += (b & 127) * 2 ** shift; shift += 7; if (shift > 35) throw new Error('Delta size overflow'); } while (b & 128); return n; };
  if (variable() !== base.length) throw new Error('Delta base size mismatch');
  const size = variable(); if (size > 32 * 1024 * 1024) throw new Error('Delta size limit');
  const out = Buffer.alloc(size); let q = 0;
  while (p < program.length) {
    const op = byte(); let start = 0, len = 0;
    if (op & 128) {
      for (let i = 0; i < 4; i++) if (op & (1 << i)) start += byte() * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (16 << i)) len += byte() * 2 ** (8 * i);
      if (!len) len = 65536;
      if (start + len > base.length || q + len > size) throw new Error('Invalid delta copy');
      base.copy(out, q, start, start + len); q += len;
    } else {
      len = op; if (!len || p + len > program.length || q + len > size) throw new Error('Invalid delta literal');
      program.copy(out, q, p, p + len); p += len; q += len;
    }
  }
  if (q !== size) throw new Error('Delta result size mismatch'); return out;
}
export function unpack(data: Buffer, existing: Map<string, Obj>) {
  if (data.length < 32 || data.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(data.readUInt32BE(4))) throw new Error('Invalid pack header');
  if (!digest(data.subarray(0, -20)).equals(data.subarray(-20))) throw new Error('Pack checksum mismatch');
  const count = data.readUInt32BE(8); if (count > 100000) throw new Error('Pack object count limit');
  let p = 12, expanded = 0; const entries: any[] = [], offsets = new Map<number, any>(), result = new Map<string, Obj>();
  const byte = () => { if (p >= data.length - 20) throw new Error('Truncated pack'); return data[p++]; };
  for (let i = 0; i < count; i++) {
    const offset = p; let b = byte(), type = (b >> 4) & 7, size = b & 15, shift = 4;
    while (b & 128) { b = byte(); size += (b & 127) * 2 ** shift; shift += 7; if (shift > 35) throw new Error('Pack size overflow'); }
    if (size > 32 * 1024 * 1024) throw new Error('Object size limit');
    let baseOffset, baseId;
    if (type === 6) { b = byte(); let distance = b & 127; while (b & 128) { b = byte(); distance = (distance + 1) * 128 + (b & 127); if (distance > offset) throw new Error('Invalid ofs delta'); } baseOffset = offset - distance; }
    else if (type === 7) { if (p + 20 > data.length - 20) throw new Error('Truncated ref delta'); baseId = data.subarray(p, p + 20).toString('hex'); p += 20; }
    else if (!types[type]) throw new Error('Invalid object type');
    const inflated: any = inflateSync(data.subarray(p, -20), { info: true, maxOutputLength: Math.max(1, size) });
    const body: Buffer = inflated.buffer; p += inflated.engine.bytesWritten;
    if (body.length !== size) throw new Error('Pack object length mismatch');
    expanded += size; if (expanded > 128 * 1024 * 1024) throw new Error('Pack expansion limit');
    const e: any = { offset, type, body, baseOffset, baseId }; entries.push(e); offsets.set(offset, e);
    if (types[type]) { e.object = { type: types[type], data: body }; result.set(hash(e.object.type, body), e.object); }
  }
  if (p !== data.length - 20) throw new Error('Unexpected pack trailing bytes');
  let unresolved = entries.filter(e => !e.object);
  for (let round = 0; unresolved.length; round++) {
    if (round > 100) throw new Error('Delta chain limit'); let progress = false;
    unresolved = unresolved.filter(e => {
      const base = e.baseId ? result.get(e.baseId) ?? existing.get(e.baseId) : offsets.get(e.baseOffset)?.object;
      if (!base) return true;
      const body = delta(base.data, e.body); expanded += body.length; if (expanded > 128 * 1024 * 1024) throw new Error('Pack expansion limit');
      e.object = { type: base.type, data: body }; result.set(hash(base.type, body), e.object); progress = true; return false;
    });
    if (!progress && unresolved.length) throw new Error('Unresolved delta base');
  }
  return result;
}
export const pkt = (s: string | Buffer) => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s); if (b.length > 65516) throw new Error('Packet too long'); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]); };
export const FLUSH = Buffer.from('0000'), DELIM = Buffer.from('0001');
export function packets(data: Buffer, stopAtFlush = false) {
  const lines: string[] = []; let p = 0;
  while (p < data.length) {
    const h = data.toString('ascii', p, p + 4); if (!/^[0-9a-fA-F]{4}$/.test(h)) throw new Error('Invalid packet length');
    const n = parseInt(h, 16); p += 4;
    if (n <= 2) { if (n === 0 && stopAtFlush) break; continue; }
    if (n < 4 || n > 65520 || p + n - 4 > data.length) throw new Error('Truncated packet');
    lines.push(data.toString('utf8', p, p + n - 4).replace(/\n$/, '')); p += n - 4;
  }
  return { lines, offset: p };
}
export function sideband(data: Buffer) {
  const out = [];
  for (let p = 0; p < data.length; p += 64000) out.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(p, p + 64000)])));
  return Buffer.concat(out);
}
export function validRef(ref: any) { return typeof ref === 'string' && /^refs\/(heads|tags)\/.+/.test(ref) && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) && !ref.includes('..') && !ref.includes('@{') && !ref.includes('//') && !ref.endsWith('/') && ref.split('/').every(x => !x.startsWith('.') && !x.endsWith('.') && !x.endsWith('.lock')); }
export function gitService(repo: any, service: string, advertise: boolean, v2: boolean, body: Buffer) {
  const objects: Map<string, Obj> = repo.objects, refs: Map<string, string> = repo.refs;
  const head = `refs/heads/${repo.default_branch}`;
  const receive = service === 'git-receive-pack';
  if (advertise) {
    if (v2 && !receive) return Buffer.concat([pkt('version 2\n'), pkt('agent=harbor-forge/1\n'), pkt('ls-refs=unborn\n'), pkt('fetch=shallow filter\n'), pkt('object-format=sha1\n'), FLUSH]);
    const caps = receive ? 'report-status side-band-64k delete-refs ofs-delta' : `side-band-64k shallow ofs-delta symref=HEAD:${head}`;
    const entries = [...refs]; if (!receive && refs.has(head)) entries.unshift(['HEAD', refs.get(head)!]);
    const out = [pkt(`# service=${service}\n`), FLUSH];
    if (!entries.length) out.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
    else entries.forEach(([ref, id], i) => { out.push(pkt(`${id} ${ref}${i === 0 ? '\0' + caps : ''}\n`)); if (objects.get(id)?.type === 'tag') out.push(pkt(`${peel(objects, id)} ${ref}^{}\n`)); });
    return Buffer.concat([...out, FLUSH]);
  }
  if (receive) {
    const { lines, offset } = packets(body, true); const caps = lines[0]?.split('\0')[1] || '';
    const commands = lines.map(line => { const [old, next, ref] = line.split('\0')[0].split(' '); if (!oidOK(old) || !oidOK(next) || !validRef(ref)) throw new Error('Invalid update command'); return { old, next, ref }; });
    let unpackError = ''; let incoming = new Map<string, Obj>();
    try { if (offset < body.length) incoming = unpack(body.subarray(offset), objects); } catch (e: any) { unpackError = e.message; }
    const combined: any = { get: (id: string) => incoming.get(id) ?? objects.get(id), has: (id: string) => incoming.has(id) || objects.has(id) };
    const trusted: Set<string> = repo.validated ??= new Set();
    const seenRefs = new Set<string>();
    const reports = commands.map(c => {
      let reason = unpackError ? 'unpacker error' : '';
      if (seenRefs.has(c.ref)) reason = 'duplicate ref command'; seenRefs.add(c.ref);
      if (!reason && (refs.get(c.ref) ?? ZERO) !== c.old) reason = 'stale ref';
      if (!reason && c.next !== ZERO) {
        try {
          if (!combined.has(c.next)) throw new Error('missing object');
          if (c.ref.startsWith('refs/heads/') && combined.get(c.next)?.type !== 'commit') throw new Error('branch must point to commit');
          validateGraph(combined, c.next, trusted);
          if (c.old !== ZERO && !ancestor(combined, c.old, c.next)) reason = 'non-fast-forward';
        } catch { reason = 'missing or invalid object'; }
      }
      return { ...c, reason };
    });
    if (!unpackError) {
      for (const [id, o] of incoming) if (!objects.has(id)) objects.set(id, o);
      for (const c of reports) if (!c.reason) { if (c.next === ZERO) refs.delete(c.ref); else refs.set(c.ref, c.next); repo.revision++; }
      repo.packCache.clear();
    }
    const report = Buffer.concat([pkt(`unpack ${unpackError || 'ok'}\n`), ...reports.map(c => pkt(c.reason ? `ng ${c.ref} ${c.reason}\n` : `ok ${c.ref}\n`)), FLUSH]);
    return caps.includes('side-band-64k') ? Buffer.concat([sideband(report), FLUSH]) : report;
  }
  const { lines } = packets(body);
  if (v2 && lines.includes('command=ls-refs')) {
    const prefixes = lines.filter(x => x.startsWith('ref-prefix ')).map(x => x.slice(11));
    const entries: [string, string][] = [['HEAD', refs.get(head) ?? 'unborn'], ...refs]; const out = [];
    for (const [ref, id] of entries) {
      if (prefixes.length && !prefixes.some(p => ref.startsWith(p))) continue;
      if (id === 'unborn' && !lines.includes('unborn')) continue;
      const attrs = ref === 'HEAD' && lines.includes('symrefs') ? ` symref-target:${head}` : '';
      const peeled = lines.includes('peel') && objects.get(id)?.type === 'tag' ? ` peeled:${peel(objects, id)}` : '';
      out.push(pkt(`${id} ${ref}${attrs}${peeled}\n`));
    }
    return Buffer.concat([...out, FLUSH]);
  }
  if (v2 && !lines.includes('command=fetch')) throw new Error('Unsupported git command');
  const values = (prefix: string) => lines.filter(x => x.startsWith(prefix + ' ')).map(x => x.slice(prefix.length + 1).split(' ')[0]);
  const wants = values('want'), haves = values('have').filter(x => objects.has(x)), oldShallow = new Set(values('shallow'));
  if (!wants.length || wants.some(x => !oidOK(x) || !objects.has(x))) throw new Error('Invalid want');
  const depth = Number(values('deepen')[0] ?? Infinity); if (!(depth > 0)) throw new Error('Invalid depth');
  if (lines.some(x => x.startsWith('deepen-since ') || x.startsWith('deepen-not '))) throw new Error('Unsupported deepen mode');
  const relative = lines.includes('deepen-relative');
  if (relative && (!Number.isSafeInteger(depth) || !oldShallow.size)) throw new Error('Relative deepen requires depth and shallow boundaries');
  const filter = values('filter')[0]; if (filter && filter !== 'blob:none' && !/^blob:limit=\d+$/.test(filter)) throw new Error('Unsupported filter');
  const key = JSON.stringify([wants, haves, [...oldShallow], depth, relative, filter, v2, lines.includes('done')]);
  if (repo.packCache.has(key)) return repo.packCache.get(key);
  let wanted = reachable(objects, wants, relative ? Infinity : depth, relative ? oldShallow : new Set());
  if (relative) {
    const extended = reachable(objects, [...oldShallow], depth + 1);
    wanted = { ids: new Set([...wanted.ids, ...extended.ids]), shallow: extended.shallow };
  }
  const held = reachable(objects, haves, Infinity, oldShallow).ids;
  const explicitWants = new Set(wants);
  const ids = [...wanted.ids].filter(id => !held.has(id) && (explicitWants.has(id) || !(objects.get(id)?.type === 'blob' && (filter === 'blob:none' || (filter?.startsWith('blob:limit=') && objects.get(id)!.data.length >= Number(filter.slice(11)))))));
  const boundaries = [...wanted.shallow], unshallow = [...oldShallow].filter(id => wanted.ids.has(id) && !wanted.shallow.has(id));
  const out: Buffer[] = [];
  if (v2) {
    // A negotiating request without done needs acknowledgments before any pack sections.
    // ready terminates negotiation; the following delimiter introduces the actual transfer.
    if (!lines.includes('done')) out.push(pkt('acknowledgments\n'), ...(haves.length ? haves.map(id => pkt(`ACK ${id}\n`)) : [pkt('NAK\n')]), pkt('ready\n'), DELIM);
    if (boundaries.length || unshallow.length) out.push(pkt('shallow-info\n'), ...boundaries.map(id => pkt(`shallow ${id}\n`)), ...unshallow.map(id => pkt(`unshallow ${id}\n`)), DELIM);
    out.push(pkt('packfile\n'));
  } else {
    if (Number.isFinite(depth)) out.push(...boundaries.map(id => pkt(`shallow ${id}\n`)), ...unshallow.map(id => pkt(`unshallow ${id}\n`)), FLUSH);
    out.push(pkt('NAK\n'));
  }
  out.push(sideband(pack(objects, ids)), FLUSH);
  const response = Buffer.concat(out);
  if (repo.packCache.size >= 8) repo.packCache.delete(repo.packCache.keys().next().value);
  if (response.length < 8 * 1024 * 1024) repo.packCache.set(key, response);
  return response;
}
