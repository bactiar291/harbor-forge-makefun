# Harbor Forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bactiar291/harbor-forge-makefun/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![reward](https://make.fun/badge/github-core-clone-01/bactiar291/harbor-forge-makefun/reward.svg)](https://make.fun/bounty/github-core-clone-01)

An original, dependency-free Git forge for the make.fun github-core-clone-01 contract. Runs directly on Node 22 using erasable TypeScript and standard-library HTTP, crypto, and zlib. There is no install step, runtime Git process, native addon, proxy, model call, or external service.

## Run

The trial provides MAKEFUN_ENV_URL and MAKEFUN_SHOP_TOKEN. MAKEFUN_TRIAL_NOW supplies deterministic timestamps. Start from the repository root:

    node main.ts

Node 22.18 or newer is needed for native TypeScript stripping; development verification used Node v22.23.5. The forge listens on port 0, registers its assigned port with the environment, polls /done, and closes with exit code 0 after completion. MAKEFUN_BIND_HOST defaults to 0.0.0.0; set it to 127.0.0.1 for local tests. /healthz is unauthenticated. Every other surface requires Authorization: Bearer with the supplied token.

The process never reads fixture/reference files or scorer exports. Its only outgoing requests are the environment's /register and /done lifecycle requests. All repository data lives in memory for the lifetime of the process.

## Implemented surfaces

- Git smart HTTP: upload-pack v2 and v0; receive-pack v0; SHA-1 blob/tree/commit/tag objects; PACK v2 output and v2/v3 input; OFS_DELTA and REF_DELTA decoding; checksum and object-link validation; sideband framing; ls-refs prefixes, symrefs, tag peeling and unborn HEAD; incremental fetch; absolute and relative shallow deepening; blob:none and blob:limit filtering; fast-forward checks and independent mixed-push results; branch and tag deletion. Immutable objects cache their compressed representation, and fetch responses use bounded per-repository caches.
- REST /api/v3: repository create/read/update/delete/list, Link pagination, branches, commits and Git refs, nested content read/write/delete with base64 and stale-SHA protection, labels, issues, comments, state filtering, pull requests, changed files, mergeability and squash merges. Contents writes and merges create real Git objects served to Git clients.
- GraphQL /api/graphql: lexer and recursive-descent parser, named operations, variables/defaults, aliases, named/inline fragments, include/skip directives, selection validation, argument/input validation, ordered HTTP batching, relevant schema introspection, Relay node identities, cursor connections, and shared issue/PR/comment mutations.
- MCP /mcp: Streamable HTTP JSON responses, 2026-07-28 discovery, 2025-11-25 initialize negotiation, notification acknowledgment, stable typed tool schemas, preserved request IDs, protocol errors and eight tools: create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request, get_file_contents and add_issue_comment.

All surfaces use the same Store. REST node_id and GraphQL id identify the same resources, and MCP returns the same REST views.

## Architecture

main.ts owns authentication, bounded HTTP bodies, lifecycle and MCP dispatch. store.ts owns repository resources, REST routing, tree-backed content operations and three-way file-level merging. git.ts owns canonical objects, pack/delta codecs, graph traversal and smart-HTTP framing. graphql.ts owns parsing, schema metadata, validation and execution. test/core.test.ts exercises the object and cross-surface invariants without external dependencies.

## Tests and local evidence

Run the repository tests:

    node --test test/core.test.ts

The build workspace also retains parent-side runners and full raw exports outside the repository:

    /tmp/makefun/runtime/node-v22.23.5-linux-x64/bin/node /tmp/makefun/forge-tests/run.mjs new-case-name 0
    /tmp/makefun/runtime/node-v22.23.5-linux-x64/bin/node /tmp/makefun/forge-tests/regression.mjs new-peer-case-name

Case names must be unused: the runners refuse to reuse existing output directories. They construct clean child environments, use the unmodified public env/scorer, wait for the actual ready file and HTTP readiness, and stop only their own child processes. The peer runner uses system Git exclusively as an external client; the forge itself never invokes it.

On the final first-pass source, all three public practice instances and a fresh public-generator seed passed 120/120 checks: Git 30, repositories 15, issues 15, pulls 20, GraphQL 20, MCP 15, protocol 5. Local scores were 940, 919, 937 and 942; a repeated trial-0 run scored 912 with the same conformance results. These are localhost measurements from the public scorer, not official grading or a prediction of production speed. Timings and full check details remain under /tmp/makefun/forge-tests. The fresh generator seed changes trial metadata but the public generator intentionally uses a fixed scenario; no claim of additional sealed-data coverage is made.

## Boundaries and limitations

This is the competition's core API subset, not a complete GitHub replacement. There are no organizations, multi-user permissions, web UI, durable disk storage, webhooks, Actions, SSH, LFS, or review workflows. Only squash merging is supported. Merge conflict detection is conservative at file granularity; disjoint edits within the same file may conflict. Diff counts use a common-prefix/suffix edit region rather than a minimal line-diff algorithm. Generated commit identities use the forge identity, while pushed commit bytes are retained exactly.

The trial supplies an opaque bearer token but no owner login. The implementation binds that credential to the first authenticated owner-qualified request for an existing repository, then rejects other owners with 404. Before binding, /user and repository owner views use the neutral login "forge". This bootstrap assumption is necessary for the supplied wire inputs, is not a general multi-user authentication design, and contains no fixture usernames or fixture-ID cases.

Git does not support deepen-since/deepen-not, push options, atomic pushes, signed-push certificates or delta-compressed output. It does decode client deltas. The advertised filter feature supports blob:none and blob:limit, not all Git filter expressions. Very large repositories are outside this memory-only entry's design; request, object-expansion and traversal limits reject oversized inputs.

GraphQL implements the relevant schema rather than the whole GitHub schema or the full GraphQL specification: no subscriptions, block strings, arbitrary custom directives, full validation-rule coverage, or sophisticated field-error/null propagation. MCP uses JSON responses rather than an SSE event stream; no background notifications, resumable event store or persistent sessions are needed by this subset.

MIT licensed. Planned public repository: bactiar291/harbor-forge-makefun. Publication and submission are performed separately by the parent session.
