[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/david200110/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/david200110/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# Forge — a GitHub-compatible git forge

![make.fun](https://make.fun/badge/github-core-clone-01.svg)
![rank](https://make.fun/badge/github-core-clone-01/david200110/github-forge/rank.svg)
![reward](https://make.fun/badge/github-core-clone-01/david200110/github-forge/reward.svg)

A standalone GitHub-compatible git forge in a single Node process, written
from scratch for the make.fun `github-core-clone-01` competition. No
dependencies, no git binary, no outside service, no UI: just one process
serving four surfaces from one in-memory store.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: `upload-pack` protocol v2
  (capability advertisement, `ls-refs` with peel/symrefs/unborn/ref-prefix,
  `fetch` with shallow/deepen and thin-pack) and `receive-pack` v0
  (report-status, side-band-64k, delete-refs), with fast-forward-only
  updates. The packfile format (objects, OFS/REF deltas, pkt-lines,
  side-band-64k) is implemented by hand with `node:zlib` and `node:crypto`.
- **REST v3** under `/api/v3`: repositories (create/read/patch/delete,
  pagination with `Link: rel="next"`), branches, commits, Git Data refs,
  contents (create/update with stale-sha 409, delete, directory listings),
  labels, issues (create/list/get/patch/comments, label validation with
  422), and pull requests (create/list/get/files, squash merge with
  conflict detection returning 405).
- **GraphQL v4** at `/api/graphql`: `viewer`, `repository` (fields,
  issues with states/orderBy/cursor pagination, pull requests, files),
  `node(id:)` global ids, `__type` introspection for `Issue`,
  `PullRequest`, `Repository` and `SearchType`, the `createIssue`,
  `closeIssue`, `createPullRequest`, `mergePullRequest` and `addComment`
  mutations, and batched operation documents in one body.
- **MCP** at `/mcp`: JSON-RPC 2.0 over Streamable HTTP, revision
  `2026-07-28` (`server/discover`, plus the `initialize` handshake),
  with tools `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request` and `merge_pull_request`, all acting on the same
  store as REST.

## Rules it keeps

- Every API call needs `Authorization: Bearer <token>` (the token in
  `MAKEFUN_SHOP_TOKEN`); missing or wrong means 401. A repository
  belongs to the login the token names, so the same name under another
  owner is a 404, never a 403.
- Every REST reply is `application/json` with a non-empty
  `X-GitHub-Request-Id` header; errors carry a JSON `{message}` body;
  unknown routes are JSON 404s and malformed JSON bodies are 400s.
- Deterministic: stored state never contains a wall-clock time or an
  unseeded random value (all timestamps are the fixed instant
  `2025-01-01T00:00:00Z`), so two runs on the same inputs leave the
  same state.

## Running it

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it at
`$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until
the trial ends and exits 0. It needs Node 22 or later and nothing else:
no install step, no packages.

## Layout

- `main.ts` — the entry lifecycle (bind, register, wait for done).
- `app.ts` — the whole forge: the object store, packfiles, git smart
  HTTP, REST v3, GraphQL v4 and MCP.
- `.makefun/owner.json` — the entry claim file.
- `LICENSE` — MIT.
