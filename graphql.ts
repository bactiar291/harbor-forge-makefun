// SPDX-License-Identifier: MIT
import { Store, fail } from './store.ts';
// A bounded recursive-descent GraphQL reader. Values and selections are parsed independently
// of operation names, so aliases, variables and fragments use the same executor.
const VARIABLE = Symbol('GraphQL variable');
export function parse(source: string) {
  if (typeof source !== 'string' || source.length > 262144) throw new Error('Invalid query');
  const tokens: string[] = []; const lex = /\s+|#[^\n]*|,|\.\.\.|"(?:\\.|[^"\\])*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|[_A-Za-z][_0-9A-Za-z]*|[!$():=@\[\]{|}]/gy;
  let pos = 0;
  while (pos < source.length) { lex.lastIndex = pos; const m = lex.exec(source); if (!m) throw new Error(`Unexpected character at ${pos}`); pos = lex.lastIndex; if (!/^[\s,#]/.test(m[0])) tokens.push(m[0]); }
  let i = 0, depth = 0;
  const peek = () => tokens[i]; const take = () => { if (i >= tokens.length) throw new Error('Unexpected end of document'); return tokens[i++]; };
  const expect = (s: string) => { if (take() !== s) throw new Error(`Expected ${s}`); };
  const name = () => { const n = take(); if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(n)) throw new Error('Expected name'); return n; };
  const value = (): any => {
    if (++depth > 100) throw new Error('Query nesting limit');
    let v: any; const t = take();
    if (t === '$') v = { [VARIABLE]: name() };
    else if (t === '[') { v = []; while (peek() !== ']') v.push(value()); expect(']'); }
    else if (t === '{') { v = Object.create(null); while (peek() !== '}') { const k = name(); expect(':'); v[k] = value(); } expect('}'); }
    else if (t.startsWith('"')) v = JSON.parse(t);
    else if (/^-?\d/.test(t)) v = Number(t);
    else if (t === 'true' || t === 'false') v = t === 'true';
    else if (t === 'null') v = null;
    else if (/^[_A-Za-z]/.test(t)) v = t; else throw new Error('Invalid value');
    depth--; return v;
  };
  const args = () => { const a = Object.create(null); if (peek() === '(') { take(); while (peek() !== ')') { const k = name(); expect(':'); a[k] = value(); } take(); } return a; };
  const directives = () => { const out = []; while (peek() === '@') { take(); out.push({ name: name(), args: args() }); } return out; };
  const selection = (): any[] => {
    if (++depth > 100) throw new Error('Query nesting limit'); expect('{'); const out = [];
    while (peek() !== '}') {
      if (peek() === '...') { take(); if (peek() === 'on') { take(); const type = name(), dirs = directives(); out.push({ type, dirs, fields: selection() }); } else if (peek() === '@' || peek() === '{') { const dirs = directives(); out.push({ dirs, fields: selection() }); } else { const spread = name(); out.push({ spread, dirs: directives() }); } }
      else { const first = name(); let field = first; if (peek() === ':') { take(); field = name(); } const a = args(), dirs = directives(); out.push({ name: field, alias: first, args: a, dirs, fields: peek() === '{' ? selection() : null }); }
    }
    take(); depth--; return out;
  };
  const typeName = (): string => { let t: string; if (peek() === '[') { take(); t = '[' + typeName(); expect(']'); t += ']'; } else t = name(); if (peek() === '!') t += take(); return t; };
  const operations: any[] = [], fragments = Object.create(null);
  while (i < tokens.length) {
    if (peek() === '{') { operations.push({ kind: 'query', fields: selection(), variables: [] }); continue; }
    const kind = take();
    if (kind === 'fragment') { const n = name(); expect('on'); const type = name(), dirs = directives(); fragments[n] = { type, dirs, fields: selection() }; continue; }
    if (!['query', 'mutation'].includes(kind)) throw new Error(`Unsupported operation ${kind}`);
    const n = peek() !== '(' && peek() !== '{' && peek() !== '@' ? name() : null, variables = [];
    if (peek() === '(') { take(); while (peek() !== ')') { expect('$'); const v = name(); expect(':'); const type = typeName(); let def; if (peek() === '=') { take(); def = value(); } variables.push({ name: v, type, def }); } take(); }
    const dirs = directives(); operations.push({ kind, name: n, variables, dirs, fields: selection() });
  }
  return { operations, fragments };
}
const schema: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', nodes: '[Node]', __type: '__Type', __schema: '__Schema' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', reopenIssue: 'CloseIssuePayload', updateIssue: 'CreateIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  User: { id: 'ID', databaseId: 'Int', login: 'String', name: 'String', repositories: 'RepositoryConnection' },
  Repository: { id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User', description: 'String', isPrivate: 'Boolean', url: 'URI', defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest', labels: 'LabelConnection' },
  Issue: { id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'IssueState', createdAt: 'DateTime', updatedAt: 'DateTime', closed: 'Boolean', url: 'URI', author: 'User', repository: 'Repository', comments: 'IssueCommentConnection', labels: 'LabelConnection' },
  PullRequest: { id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState', merged: 'Boolean', headRefName: 'String', baseRefName: 'String', headRefOid: 'GitObjectID', baseRefOid: 'GitObjectID', mergeable: 'MergeableState', files: 'PullRequestChangedFileConnection', url: 'URI', repository: 'Repository', author: 'User', createdAt: 'DateTime', updatedAt: 'DateTime' },
  Ref: { name: 'String', target: 'Commit' }, Commit: { oid: 'GitObjectID' },
  Label: { id: 'ID', name: 'String', color: 'String', description: 'String' },
  IssueComment: { id: 'ID', databaseId: 'Int', body: 'String', createdAt: 'DateTime', author: 'User' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', endCursor: 'String', startCursor: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' }, CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' }, CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' }, MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' }, AddCommentPayload: { commentEdge: 'IssueCommentEdge', clientMutationId: 'String' },
  Node: { id: 'ID' },
  __Schema: { queryType: '__Type', mutationType: '__Type', types: '[__Type]', directives: '[__Directive]' },
  __Type: { name: 'String', kind: '__TypeKind', description: 'String', fields: '[__Field]', enumValues: '[__EnumValue]', ofType: '__Type', interfaces: '[__Type]', possibleTypes: '[__Type]', inputFields: '[__InputValue]' },
  __Field: { name: 'String', description: 'String', type: '__Type', args: '[__InputValue]', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __EnumValue: { name: 'String', description: 'String', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __InputValue: { name: 'String', description: 'String', type: '__Type', defaultValue: 'String' },
  __Directive: { name: 'String', description: 'String', locations: '[String]', args: '[__InputValue]' }
};
const enums: Record<string, string[]> = { IssueState: ['OPEN', 'CLOSED'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'], MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'], SearchType: ['ISSUE', 'REPOSITORY', 'USER'], PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'], IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'], OrderDirection: ['ASC', 'DESC'] };
for (const type of ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'PullRequestChangedFile', 'Label']) {
  schema[type + 'Connection'] = { nodes: `[${type}]`, edges: `[${type}Edge]`, pageInfo: 'PageInfo', totalCount: 'Int' };
  schema[type + 'Edge'] = { node: type, cursor: 'String' };
}
const inputs: Record<string, Record<string, string>> = {
  CreateIssueInput: { repositoryId: 'ID!', title: 'String!', body: 'String', clientMutationId: 'String' },
  CloseIssueInput: { issueId: 'ID!', clientMutationId: 'String' }, ReopenIssueInput: { issueId: 'ID!', clientMutationId: 'String' },
  UpdateIssueInput: { id: 'ID!', title: 'String', body: 'String', clientMutationId: 'String' },
  CreatePullRequestInput: { repositoryId: 'ID!', title: 'String!', body: 'String', headRefName: 'String!', baseRefName: 'String!', clientMutationId: 'String' },
  MergePullRequestInput: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod', clientMutationId: 'String' },
  AddCommentInput: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' },
  IssueOrder: { field: 'IssueOrderField!', direction: 'OrderDirection!' }
};
const fieldArgs: Record<string, Record<string, string>> = {
  'Query.repository': { owner: 'String!', name: 'String!' }, 'Query.node': { id: 'ID!' }, 'Query.nodes': { ids: '[ID!]!' }, 'Query.__type': { name: 'String!' },
  'Repository.issue': { number: 'Int!' }, 'Repository.pullRequest': { number: 'Int!' },
  'Repository.issues': { first: 'Int', after: 'String', states: '[IssueState!]', orderBy: 'IssueOrder' },
  'Repository.pullRequests': { first: 'Int', after: 'String', states: '[PullRequestState!]' },
  '__Type.fields': { includeDeprecated: 'Boolean' }, '__Type.enumValues': { includeDeprecated: 'Boolean' },
  'Mutation.createIssue': { input: 'CreateIssueInput!' }, 'Mutation.closeIssue': { input: 'CloseIssueInput!' }, 'Mutation.reopenIssue': { input: 'ReopenIssueInput!' }, 'Mutation.updateIssue': { input: 'UpdateIssueInput!' },
  'Mutation.createPullRequest': { input: 'CreatePullRequestInput!' }, 'Mutation.mergePullRequest': { input: 'MergePullRequestInput!' }, 'Mutation.addComment': { input: 'AddCommentInput!' }
};
for (const field of ['User.repositories', 'Repository.labels', 'Issue.comments', 'Issue.labels', 'PullRequest.files']) fieldArgs[field] = { first: 'Int', after: 'String' };
const baseType = (s: string) => s.replace(/[\[\]!]/g, '');
function typeRef(name: string): any {
  if (name.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: typeRef(name.slice(0, -1)) };
  if (name.startsWith('[')) return { kind: 'LIST', name: null, ofType: typeRef(name.slice(1, -1)) };
  return { kind: inputs[name] ? 'INPUT_OBJECT' : enums[name] ? 'ENUM' : schema[name] ? name === 'Node' ? 'INTERFACE' : 'OBJECT' : 'SCALAR', name, ofType: null };
}
const inputFields = (fields: Record<string, string>) => Object.entries(fields).map(([name, type]) => ({ name, type: typeRef(type), description: null, defaultValue: null }));
function introspect(name: string): any {
  if (!schema[name] && !inputs[name] && !enums[name] && !['ID', 'Int', 'String', 'Boolean', 'DateTime', 'URI', 'GitObjectID'].includes(name)) return null;
  return { ...typeRef(name), description: `${name} in Harbor Forge`, fields: schema[name] ? Object.entries(schema[name]).map(([field, type]) => ({ name: field, type: typeRef(type), args: inputFields(fieldArgs[`${name}.${field}`] ?? {}), description: null, isDeprecated: false, deprecationReason: null })) : null, enumValues: enums[name]?.map(name => ({ name, description: null, isDeprecated: false, deprecationReason: null })) ?? null, interfaces: ['Repository', 'Issue', 'PullRequest', 'IssueComment'].includes(name) ? [typeRef('Node')] : [], possibleTypes: name === 'Node' ? ['Repository', 'Issue', 'PullRequest', 'IssueComment'].map(typeRef) : null, inputFields: inputs[name] ? inputFields(inputs[name]) : null };
}
function connection(items: any[], args: any) {
  const cursor = (n: number) => Buffer.from(`cursor:${n}`).toString('base64');
  let start = 0; if (args.after) { const text = Buffer.from(args.after, 'base64').toString(); if (!/^cursor:\d+$/.test(text)) throw new Error('Invalid cursor'); start = Number(text.slice(7)) + 1; }
  const count = args.first ?? 30; if (!Number.isInteger(count) || count < 0 || count > 100) throw new Error('first must be between 0 and 100');
  const nodes = items.slice(start, start + count), edges = nodes.map((node, i) => ({ node, cursor: cursor(start + i) }));
  return { nodes, edges, totalCount: items.length, pageInfo: { hasNextPage: start + count < items.length, hasPreviousPage: start > 0, startCursor: nodes.length ? cursor(start) : null, endCursor: nodes.length ? cursor(start + nodes.length - 1) : null } };
}
export function graphql(store: Store, body: any): any {
  if (Array.isArray(body)) { if (body.length > 50) return { errors: [{ message: 'Batch limit' }] }; return body.map(b => graphql(store, b)); }
  try {
    const doc = parse(body?.query), operation = body.operationName ? doc.operations.find(o => o.name === body.operationName) : doc.operations.length === 1 ? doc.operations[0] : null;
    if (!operation) throw new Error('Choose one operation');
    const vars = { ...(body.variables ?? {}) };
    const evalValue = (v: any): any => { if (v === null || typeof v !== 'object') return v; if (Array.isArray(v)) return v.map(evalValue); if (v[VARIABLE]) return vars[v[VARIABLE]]; return Object.fromEntries(Object.entries(v).map(([k, v]) => [k, evalValue(v)])); };
    const coerce = (value: any, type: string, label: string): any => {
      if (type.endsWith('!')) { if (value == null) throw new Error(`${label} is required`); return coerce(value, type.slice(0, -1), label); }
      if (value == null) return value;
      if (type.startsWith('[')) return (Array.isArray(value) ? value : [value]).map((v, i) => coerce(v, type.slice(1, -1), `${label}[${i}]`));
      if (inputs[type]) {
        if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an input object`);
        for (const key of Object.keys(value)) if (!inputs[type][key]) throw new Error(`Unknown input field ${key}`);
        return Object.fromEntries(Object.entries(inputs[type]).map(([key, child]) => [key, coerce(value[key], child, `${label}.${key}`)]).filter(([, v]) => v !== undefined));
      }
      if (enums[type]) { if (!enums[type].includes(value)) throw new Error(`${label} is not a ${type}`); return value; }
      if (type === 'Int' && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) throw new Error(`${label} must be Int`);
      if (type === 'Boolean' && typeof value !== 'boolean') throw new Error(`${label} must be Boolean`);
      if (type === 'String' && typeof value !== 'string') throw new Error(`${label} must be String`);
      if (type === 'ID') { if (typeof value !== 'string' && !Number.isInteger(value)) throw new Error(`${label} must be ID`); return String(value); }
      return value;
    };
    for (const v of operation.variables) { if (vars[v.name] === undefined && v.def !== undefined) vars[v.name] = evalValue(v.def); vars[v.name] = coerce(vars[v.name], v.type, `$${v.name}`); }
    const include = (dirs: any[]) => { let yes = true; for (const d of dirs ?? []) { if (!['skip', 'include'].includes(d.name)) throw new Error(`Unknown directive ${d.name}`); const test = evalValue(d.args.if); if (typeof test !== 'boolean') throw new Error('Directive if must be Boolean'); if ((d.name === 'skip' && test) || (d.name === 'include' && !test)) yes = false; } return yes; };
    const expanded = (fields: any[], type: string, stack: string[] = []): any[] => fields.flatMap(f => {
      if (!include(f.dirs)) return [];
      if (f.spread) { if (stack.includes(f.spread)) throw new Error('Cyclic fragment'); const fr = doc.fragments[f.spread]; if (!fr) throw new Error(`Unknown fragment ${f.spread}`); return expanded([fr], type, [...stack, f.spread]); }
      if (!f.name) return !f.type || f.type === type || f.type === 'Node' || type === 'Node' ? expanded(f.fields, f.type ?? type, stack) : [];
      return [f];
    });
    const validate = (fields: any[], type: string, stack: string[] = [], depth = 0) => {
      if (depth > 100) throw new Error('Selection depth limit');
      for (const f of fields) {
        if (f.spread) { if (stack.includes(f.spread)) throw new Error('Cyclic fragment'); const fr = doc.fragments[f.spread]; if (!fr) throw new Error(`Unknown fragment ${f.spread}`); validate([fr], type, [...stack, f.spread], depth + 1); continue; }
        if (!f.name) { validate(f.fields, f.type ?? type, stack, depth + 1); continue; }
        const target = f.name === '__typename' ? 'String' : schema[type]?.[f.name];
        if (!target) throw new Error(`Cannot query field "${f.name}" on type "${type}"`);
        include(f.dirs);
        const allowed = fieldArgs[`${type}.${f.name}`] ?? {};
        for (const key of Object.keys(f.args)) if (!allowed[key]) throw new Error(`Unknown argument ${key} on ${type}.${f.name}`);
        for (const [key, argType] of Object.entries(allowed)) coerce(evalValue(f.args[key]), argType, `${f.name}.${key}`);
        if (f.fields) { if (!schema[baseType(target)]) throw new Error(`Field ${f.name} must not have selections`); validate(f.fields, baseType(target), stack, depth + 1); }
        else if (schema[baseType(target)]) throw new Error(`Field ${f.name} requires selections`);
      }
    };
    const root = operation.kind === 'mutation' ? 'Mutation' : 'Query'; validate(operation.fields, root);
    const getNode = (id: any, type?: string) => { const n = store.nodes.get(id); if (!n || (type && n._type !== type)) throw new Error('Resource not found'); return n; };
    const resolve = (obj: any, type: string, field: string, a: any): any => {
      if (field === '__typename') return obj?._type ?? type;
      if (type === 'Query') {
        if (field === 'viewer') return store.user();
        if (field === 'repository') return store.repo(a.owner, a.name, true);
        if (field === 'node') return store.nodes.get(a.id) ?? null;
        if (field === 'nodes') return a.ids.map(id => store.nodes.get(id) ?? null);
        if (field === '__type') return introspect(a.name);
        if (field === '__schema') return { queryType: typeRef('Query'), mutationType: typeRef('Mutation'), types: Object.keys({ ...schema, ...enums, ...inputs }).map(introspect), directives: ['skip', 'include'].map(name => ({ name, description: 'Conditionally select fields', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: inputFields({ if: 'Boolean!' }) })) };
      }
      if (type === 'Mutation') {
        const input = a.input; if (!input || typeof input !== 'object') throw new Error('input is required');
        const result: any = { clientMutationId: input.clientMutationId ?? null };
        if (field === 'createIssue') result.issue = store.createIssue(getNode(input.repositoryId, 'Repository'), input);
        if (field === 'closeIssue' || field === 'reopenIssue' || field === 'updateIssue') result.issue = store.patchIssue(getNode(input.issueId ?? input.id, 'Issue'), { ...input, ...(field !== 'updateIssue' ? { state: field === 'closeIssue' ? 'closed' : 'open' } : {}) });
        if (field === 'createPullRequest') result.pullRequest = store.createPull(getNode(input.repositoryId, 'Repository'), { ...input, head: input.headRefName, base: input.baseRefName });
        if (field === 'mergePullRequest') { const p = getNode(input.pullRequestId, 'PullRequest'); store.merge(p, { merge_method: (input.mergeMethod ?? 'SQUASH').toLowerCase() }); result.pullRequest = p; }
        if (field === 'addComment') { const c = store.comment(getNode(input.subjectId), input); result.commentEdge = { node: c, cursor: Buffer.from(`comment:${c.id}`).toString('base64') }; }
        return result;
      }
      if (field === 'id' && obj.node_id) return obj.node_id;
      if (field === 'databaseId') return obj.id;
      if (field === 'createdAt') return obj.created_at;
      if (field === 'updatedAt') return obj.updated_at;
      if (field === 'author') return store.user();
      if (field === 'repository') return obj._repo;
      if (type === 'User' && field === 'repositories') return connection([...store.repos.values()], a);
      if (type === 'Repository') {
        if (field === 'owner') return store.user();
        if (field === 'nameWithOwner') return `${store.user().login}/${obj.name}`;
        if (field === 'isPrivate') return obj.private;
        if (field === 'viewerPermission') return 'ADMIN';
        if (field === 'hasIssuesEnabled') return true;
        if (field === 'url') return store.repoView(obj).html_url;
        if (field === 'defaultBranchRef') { const sha = store.resolve(obj); return sha ? { name: obj.default_branch, target: { oid: sha } } : null; }
        if (field === 'issue') return obj.issues.get(a.number) ?? null;
        if (field === 'pullRequest') return obj.pulls.get(a.number) ?? null;
        if (field === 'labels') return connection([...obj.labels.values()], a);
        if (field === 'issues' || field === 'pullRequests') {
          let items = [...(field === 'issues' ? obj.issues : obj.pulls).values()];
          if (a.states) { const states = Array.isArray(a.states) ? a.states : [a.states]; items = items.filter(i => states.includes(i.merged ? 'MERGED' : i.state.toUpperCase())); }
          else if (field === 'pullRequests') items = items.filter(i => i.state === 'open');
          items.sort((x, y) => a.orderBy?.direction === 'DESC' ? y.number - x.number : x.number - y.number); return connection(items, a);
        }
      }
      if (type === 'Issue') {
        if (field === 'state') return obj.state.toUpperCase();
        if (field === 'closed') return obj.state === 'closed';
        if (field === 'comments') return connection(obj.comments, a);
        if (field === 'labels') return connection(obj.labels.map(n => obj._repo.labels.get(n)), a);
        if (field === 'url') return store.issueView(obj).html_url;
      }
      if (type === 'PullRequest') {
        if (field === 'state') return obj.merged ? 'MERGED' : obj.state.toUpperCase();
        if (field === 'headRefName') return obj.head;
        if (field === 'baseRefName') return obj.base;
        if (field === 'headRefOid') return store.resolve(obj._repo, obj.head);
        if (field === 'baseRefOid') return store.resolve(obj._repo, obj.base);
        if (field === 'mergeable') return store.mergePlan(obj).conflict ? 'CONFLICTING' : 'MERGEABLE';
        if (field === 'files') return connection(store.diff(obj).map(f => ({ ...f, changeType: f.status.toUpperCase() })), a);
        if (field === 'url') return store.pullView(obj).html_url;
      }
      return obj[field] ?? null;
    };
    let work = 0;
    const execute = (obj: any, type: string, fields: any[]): any => {
      if (obj == null) return null; if (++work > 100000) throw new Error('Query work limit');
      type = obj._type ?? type; const out = Object.create(null);
      for (const f of expanded(fields, type)) {
        const a = evalValue(f.args), value = resolve(obj, type, f.name, a), target = baseType(schema[type]?.[f.name] ?? 'String');
        const projected = f.fields ? Array.isArray(value) ? value.map(v => execute(v, target, f.fields)) : execute(value, target, f.fields) : value;
        if (out[f.alias] && projected && !Array.isArray(projected) && typeof projected === 'object') out[f.alias] = { ...out[f.alias], ...projected }; else out[f.alias] = projected;
      }
      return out;
    };
    return { data: execute({}, root, operation.fields) };
  } catch (e: any) { return { errors: [{ message: e.message }] }; }
}
