// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, rest } from '../store.ts';
import { graphql } from '../graphql.ts';
import { put, hash, pack, unpack, gitService, pkt, packets, FLUSH, ZERO } from '../git.ts';
function fixture() { const s = new Store('2026-01-01T00:00:00Z'); s.base = 'http://localhost:12345'; const r = s.createRepo({ name: 'project' }); s.repo('owner', 'project'); return { s, r }; }
const write = (s: Store, r: any, path: string, text: string, branch = 'main', sha?: string) => s.writeFile(r, path, { message: 'change', content: Buffer.from(text).toString('base64'), branch, sha });
test('canonical blob hashes and pack corruption detection', () => {
  const objects = new Map(); const id = put(objects, 'blob', 'hello\n');
  assert.equal(id, 'ce013625030ba8dba906f756967f9e9ca394464a');
  const bytes = pack(objects, [id]); assert.deepEqual(unpack(bytes, new Map()).get(id)?.data, Buffer.from('hello\n'));
  const bad = Buffer.from(bytes); bad[bad.length - 1] ^= 1; assert.throws(() => unpack(bad, objects), /checksum/);
});
test('content SHA guards, tree collisions, and deletion produce real commits', () => {
  const { s, r } = fixture(); const first = write(s, r, 'dir/file', 'one');
  assert.equal(first.body.content.sha, hash('blob', Buffer.from('one')));
  assert.throws(() => write(s, r, 'dir/file', 'stale', 'main', ZERO), /sha/);
  assert.throws(() => write(s, r, 'dir', 'collision'), /collision/);
  const deleted = s.writeFile(r, 'dir/file', { message: 'remove', sha: first.body.content.sha }, true);
  assert.ok(r.objects.has(deleted.body.commit.sha)); assert.throws(() => s.content(r, 'dir/file'), /Not Found/);
});
test('squash merge preserves unrelated base changes and detects concurrent edits', () => {
  const { s, r } = fixture(); const initial = write(s, r, 'a', 'old');
  r.refs.set('refs/heads/topic', initial.body.commit.sha); r.refs.set('refs/heads/conflict', initial.body.commit.sha);
  write(s, r, 'a', 'topic', 'topic', initial.body.content.sha); write(s, r, 'a', 'different', 'conflict', initial.body.content.sha);
  write(s, r, 'base-only', 'keep');
  s.merge(s.createPull(r, { title: 'merge', head: 'topic', base: 'main' }));
  assert.equal(Buffer.from(s.content(r, 'base-only').content, 'base64').toString(), 'keep');
  const conflicting = s.createPull(r, { title: 'conflict', head: 'conflict', base: 'main' }); assert.equal(s.mergePlan(conflicting).conflict, true); assert.throws(() => s.merge(conflicting), /conflicts/);
});
test('GraphQL fragments, directives, batch order, introspection and mutation validation', () => {
  const { s, r } = fixture();
  const query = 'query($owner:String!, $yes:Boolean! = true) { x:repository(owner:$owner,name:"project") {...R} viewer {login @include(if:$yes) name @skip(if:true)} } fragment R on Repository { id name nameWithOwner }';
  const value = graphql(s, { query, variables: { owner: 'owner' } }); assert.equal(value.errors, undefined); assert.equal(value.data.x.nameWithOwner, 'owner/project'); assert.equal(value.data.viewer.name, undefined);
  const bad = graphql(s, { query: 'mutation($i:CreateIssueInput!){createIssue(input:$i){issue{invalid}}}', variables: { i: { repositoryId: r.node_id, title: 'must not create' } } }); assert.ok(bad.errors); assert.equal(r.issues.size, 0);
  assert.ok(graphql(s, { query: '{viewer(nope:true){login}}' }).errors);
  const batch = graphql(s, [{ query: '{viewer{login}}' }, { query: '{__type(name:"CreateIssueInput"){kind inputFields{name}}}' }]); assert.equal(batch[0].data.viewer.login, 'owner'); assert.equal(batch[1].data.__type.kind, 'INPUT_OBJECT');
});
test('REST updates validate before mutation and deleted repository nodes disappear', () => {
  const { s, r } = fixture(); const i = s.createIssue(r, { title: 'before' }); assert.throws(() => s.patchIssue(i, { title: 'after', state: 'wrong' }), /Invalid state/); assert.equal(i.title, 'before');
  const call = (method: string, path: string, body: any) => rest(s, method, new URL(s.base + '/api/v3/repos/owner/project' + path), body);
  assert.throws(() => call('PATCH', '', { description: 'changed', private: 'wrong' }), /private/); assert.equal(r.description, '');
  s.removeRepo(r); assert.equal(s.nodes.has(r.node_id), false); assert.equal(s.nodes.has(i.node_id), false);
});
test('mixed receive-pack applies fast-forward and refuses sibling independently', () => {
  const { s, r } = fixture(); const initial = write(s, r, 'a', 'old'); const a = initial.body.commit.sha;
  r.refs.set('refs/heads/side', a); const b = write(s, r, 'a', 'new', 'main', initial.body.content.sha).body.commit.sha;
  const c = write(s, r, 'side', 'sibling', 'side').body.commit.sha;
  r.refs.set('refs/heads/main', a); r.refs.set('refs/heads/side', b);
  const request = Buffer.concat([pkt(`${a} ${b} refs/heads/main\0report-status\n`), pkt(`${b} ${c} refs/heads/side\n`), FLUSH]);
  const response = gitService(r, 'git-receive-pack', false, false, request); const lines = packets(response).lines;
  assert.ok(lines.includes('ok refs/heads/main')); assert.ok(lines.includes('ng refs/heads/side non-fast-forward')); assert.equal(r.refs.get('refs/heads/main'), b); assert.equal(r.refs.get('refs/heads/side'), b);
});
