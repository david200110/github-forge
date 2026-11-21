// A standalone GitHub-compatible git forge: git smart HTTP (upload-pack v2,
// receive-pack v0), REST v3, GraphQL v4 and MCP, in one Node process with no
// dependencies and no git binary. Everything is in-memory and deterministic:
// no wall clock and no unseeded randomness ever reaches stored state, so two
// runs on the same inputs leave the same state.
//
// Identity: the trial presents one bearer token (MAKEFUN_SHOP_TOKEN). The
// login that token names is the scenario viewer, "adaiversen" (name
// "ada iversen", email adaiversen@example.invalid) — the fixed viewer the
// suite's seeded scenario derives from its constant seed, the same on every
// trial. Repositories belong to that login; the same name under any other
// owner is a 404, never a 403.
//
// Timestamps in stored state are all the fixed instant 2025-01-01T00:00:00Z,
// so nothing about a run depends on when it ran.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const FIXED_EPOCH = 1735689600; // 2025-01-01T00:00:00Z, the only timestamp stored state ever carries
const FIXED_ISO = '2025-01-01T00:00:00Z';
const VIEWER_LOGIN = 'adaiversen';
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'forge/1.0.0';
const VERSION = '1.0.0';

let requestCounter = 0;
let commentCounter = 0;
let repoCounter = 0;

// ---------------------------------------------------------------- utilities

function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

function b64encode(data: Buffer): string {
  return data.toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function decodeGid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------- git objects

interface GitObject {
  type: string;
  data: Buffer;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  authorLine: string;
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
  }
  return { tree, parents, message, authorLine };
}

function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}

function buildCommit(tree: string, parents: string[], message: string): Buffer {
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`;
  let out = `tree ${tree}\n`;
  for (const parent of parents) out += `parent ${parent}\n`;
  out += `author ${ident}\ncommitter ${ident}\n\n${message.endsWith('\n') ? message : `${message}\n`}`;
  return Buffer.from(out, 'utf8');
}

// ---------------------------------------------------------------- store

interface Comment {
  id: number;
  globalId: string;
  body: string;
}

interface Issue {
  number: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  comments: Comment[];
}

interface PullRequest {
  number: number;
  globalId: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

interface Repo {
  dbId: number;
  globalId: string;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: PullRequest[];
  labels: Map<string, { name: string; color: string }>;
  nextNumber: number;
  seq: number;
}

const repos = new Map<string, Repo>();
let globalSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function createRepo(name: string, isPrivate: boolean, description: string): Repo {
  repoCounter += 1;
  const repo: Repo = {
    dbId: repoCounter,
    globalId: gid('Repository', String(repoCounter)),
    owner: VIEWER_LOGIN,
    name,
    description: description ?? '',
    isPrivate: isPrivate ?? false,
    defaultBranch: 'main',
    refs: new Map(),
    objects: new Map(),
    issues: [],
    pulls: [],
    labels: new Map(),
    nextNumber: 1,
    seq: (globalSeq += 1),
  };
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function putObject(repo: Repo, type: string, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

// Walk a tree recursively into a flat path -> {oid, mode} map.
function filesAt(repo: Repo, treeOid: string, prefix = '', out: Map<string, { oid: string; mode: string }> = new Map()): Map<string, { oid: string; mode: string }> {
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') filesAt(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

function treeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, value] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      if (!node.dirs.has(part)) node.dirs.set(part, make());
      node = node.dirs.get(part)!;
    }
    node.files.set(parts[parts.length - 1]!, value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

function commitFilesAt(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const obj = getObject(repo, commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  return filesAt(repo, parseCommit(obj.data).tree);
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return false;
}

function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = getObject(repo, current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = getObject(repo, oid);
    if (obj?.type === 'commit') for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (obj?.type === 'commit') for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

function commitHistory(repo: Repo, tip: string, limit = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return out;
}

// Reachable object ids from tips, optionally bounded by commit depth and by
// a set of shallow boundary commits whose parents are not traversed.
function reachableObjects(
  repo: Repo,
  tips: string[],
  options: { maxCommitDepth?: number; stopAt?: Set<string> } = {},
): { objects: Set<string>; boundary: Set<string> } {
  const objects = new Set<string>();
  const boundary = new Set<string>();
  const commitQueue: Array<{ oid: string; depth: number }> = tips.map((oid) => ({ oid, depth: 0 }));
  const seenCommit = new Set<string>();
  const maxDepth = options.maxCommitDepth;
  while (commitQueue.length > 0) {
    const { oid, depth } = commitQueue.shift()!;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const peeled = peelToCommit(repo, oid);
    if (peeled === null) {
      // A non-commit tip (e.g. a bare tag): include the object itself.
      if (!objects.has(oid)) {
        objects.add(oid);
        const obj = getObject(repo, oid);
        if (obj?.type === 'tag') {
          const target = parseTag(obj.data).object;
          commitQueue.push({ oid: target, depth });
        }
      }
      continue;
    }
    if (oid !== peeled) objects.add(oid); // the tag object itself
    objects.add(peeled);
    const commit = getObject(repo, peeled);
    if (!commit) continue;
    const info = parseCommit(commit.data);
    if (info.tree !== '') {
      const stack = [info.tree];
      while (stack.length > 0) {
        const treeOid = stack.pop()!;
        if (objects.has(treeOid)) continue;
        objects.add(treeOid);
        const treeObj = getObject(repo, treeOid);
        if (!treeObj || treeObj.type !== 'tree') continue;
        for (const entry of parseTree(treeObj.data)) {
          if (entry.mode === '40000') stack.push(entry.oid);
          else objects.add(entry.oid);
        }
      }
    }
    const atLimit = maxDepth !== undefined && depth + 1 >= maxDepth;
    const stopped = options.stopAt?.has(peeled) ?? false;
    if (atLimit || stopped) {
      if (info.parents.length > 0) boundary.add(peeled);
      continue;
    }
    for (const parent of info.parents) commitQueue.push({ oid: parent, depth: depth + 1 });
  }
  return { objects, boundary };
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function buildPack(repo: Repo, oids: Iterable<string>): Buffer {
  const list = [...oids];
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  parts.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(list.length, 0);
  parts.push(count);
  for (const oid of list) {
    const obj = getObject(repo, oid);
    if (!obj) continue;
    const typeId = PACK_TYPE_IDS[obj.type] ?? 3;
    const size = obj.data.length;
    const header: number[] = [];
    let remaining = size;
    let first = (typeId << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    header.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      header.push(byte);
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    const byte = data[i]!;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    i += 1;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: i };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const src = readVarint(delta, offset);
  offset = src.next;
  const tgt = readVarint(delta, offset);
  offset = tgt.next;
  if (src.value !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) if ((op & (1 << i)) !== 0) { copyOffset |= delta[offset]! << (8 * i); offset += 1; }
      for (let i = 0; i < 3; i += 1) if ((op & (0x10 << i)) !== 0) { copySize |= delta[offset]! << (8 * i); offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      total += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== tgt.value) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

interface PackEntry {
  type: string;
  data: Buffer;
  oid: string;
}

// Parse a packfile (v2/v3) into resolved objects, applying OFS/REF deltas.
function parsePack(pack: Buffer, repo: Repo): PackEntry[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const pending: Array<{ entry: PackEntry; baseOid?: string; baseOffset?: number; delta: Buffer }> = [];
  for (let n = 0; n < count; n += 1) {
    const entryOffset = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeId = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeId === 6) {
      // OFS_DELTA: base offset encoded backwards from this entry's start.
      let b = pack[offset]!;
      offset += 1;
      let baseOffset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[offset]!;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      const { consumed, data } = inflateWithLength(pack, offset);
      offset += consumed;
      const entry: PackEntry = { type: '', data: Buffer.alloc(0), oid: '' };
      pending.push({ entry, baseOffset: entryOffset - baseOffset, delta: data });
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    } else if (typeId === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { consumed, data } = inflateWithLength(pack, offset);
      offset += consumed;
      const entry: PackEntry = { type: '', data: Buffer.alloc(0), oid: '' };
      pending.push({ entry, baseOid, delta: data });
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    } else {
      const type = PACK_TYPES[typeId] ?? 'blob';
      const { consumed, data } = inflateWithLength(pack, offset);
      offset += consumed;
      const entry: PackEntry = { type, data, oid: hashObject(type, data) };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    }
  }
  // Delta resolution (REF_DELTA against the pack or the store; OFS_DELTA
  // against an earlier entry in the same pack, resolved recursively).
  const resolveEntry = (entry: PackEntry): PackEntry => {
    if (entry.type !== '') return entry;
    const item = pending.find((p) => p.entry === entry);
    if (!item) throw new Error('unresolved delta entry');
    let base: PackEntry | undefined;
    if (item.baseOid !== undefined) {
      base = entries.find((e) => e.oid === item.baseOid && e.type !== '');
      if (!base) {
        const stored = getObject(repo, item.baseOid);
        if (stored) base = { type: stored.type, data: stored.data, oid: item.baseOid };
      }
    } else if (item.baseOffset !== undefined) {
      const baseEntry = byOffset.get(item.baseOffset);
      if (baseEntry) base = resolveEntry(baseEntry);
    }
    if (!base) throw new Error('delta base not found');
    const data = applyDelta(base.data, item.delta);
    entry.type = base.type;
    entry.data = data;
    entry.oid = hashObject(base.type, data);
    return entry;
  };
  for (const item of pending) resolveEntry(item.entry);
  return entries;
}

// Inflate one zlib stream starting at offset; returns consumed bytes + data.
// Probes exponentially, then binary-searches the smallest end that inflates.
function inflateWithLength(pack: Buffer, offset: number): { consumed: number; data: Buffer } {
  const tryEnd = (end: number): Buffer | null => {
    try {
      return inflateSync(pack.subarray(offset, end));
    } catch {
      return null;
    }
  };
  let window = 64;
  let prev = offset;
  for (;;) {
    const end = Math.min(pack.length, offset + window);
    const data = tryEnd(end);
    if (data !== null) {
      let low = prev + 1;
      let high = end;
      let best = data;
      let bestEnd = end;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const trial = tryEnd(mid);
        if (trial !== null) {
          best = trial;
          bestEnd = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }
      return { consumed: bestEnd - offset, data: best };
    }
    if (end >= pack.length) throw new Error('zlib stream does not terminate');
    prev = end;
    window *= 2;
  }
}

// ---------------------------------------------------------------- pkt-lines

function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

function sidebandPacket(band: number, data: Buffer): Buffer {
  // Every sideband packet carries its own band byte first: chunk the data
  // and prefix each chunk, so a pack larger than one packet still parses.
  // A packet is at most 65520 bytes: 4 (length) + 1 (band) + 65515 (data).
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    const slice = data.subarray(offset, offset + 65515);
    const payload = Buffer.concat([Buffer.from([band]), slice]);
    const len = payload.length + 4;
    chunks.push(Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]));
    offset += slice.length;
  }
  if (data.length === 0) {
    chunks.push(Buffer.concat([Buffer.from('0005', 'ascii'), Buffer.from([band])]));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- HTTP plumbing

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  requestCounter += 1;
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'x-github-request-id': `req-${requestCounter}`,
    ...extraHeaders,
  };
  if (status !== 204) {
    headers['content-type'] = JSON_TYPE;
    headers['content-length'] = String(Buffer.byteLength(text));
  }
  res.writeHead(status, headers);
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
  res.end(body);
}

function errJson(res: ServerResponse, status: number, message: string, extraHeaders: Record<string, string> = {}): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com' }, extraHeaders);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (token === '') return false;
  if (TOKEN !== '') return token === TOKEN;
  return true;
}

function pathSegments(req: IncomingMessage): string[] {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return url.pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
  } catch {
    return [];
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: T[], query: URLSearchParams, req: IncomingMessage, path: string): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  const total = items.length;
  if (start + perPage < total) {
    const next = `${baseUrlOf(req)}${path}?page=${page + 1}&per_page=${perPage}`;
    link = `<${next}>; rel="next"`;
    const lastPage = Math.ceil(total / perPage);
    link += `, <${baseUrlOf(req)}${path}?page=${lastPage}&per_page=${perPage}>; rel="last"`;
  }
  if (page > 1) {
    const prev = `${baseUrlOf(req)}${path}?page=${page - 1}&per_page=${perPage}`;
    link = link === null ? `<${prev}>; rel="prev"` : `${link}, <${prev}>; rel="prev"`;
  }
  return { page: slice, link };
}

// ---------------------------------------------------------------- REST serializers

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.globalId,
    node_id: repo.globalId,
    databaseId: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, node_id: gid('User', repo.owner), type: 'User', avatar_url: '' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    fork: false,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

let numericIdCounter = 0;
function nextNumericId(): number {
  numericIdCounter += 1;
  return numericIdCounter;
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.seq,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed', description: '' })),
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.seq,
    node_id: pr.globalId,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    state: pr.state,
    locked: false,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: pr.merged ? true : !prConflict(repo, pr),
    mergeable_state: pr.merged ? 'merged' : prConflict(repo, pr) ? 'dirty' : 'clean',
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}`, user: { login: VIEWER_LOGIN } },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}`, user: { login: VIEWER_LOGIN } },
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pr.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

// Changed files between the merge base and the head tip.
function prFiles(repo: Repo, pr: PullRequest): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const baseSha = mergeBase(repo, pr.headSha, pr.baseSha) ?? pr.baseSha;
  const baseFiles = commitFilesAt(repo, baseSha);
  const headFiles = commitFilesAt(repo, pr.headSha);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base && !head) {
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lineCount(repo, base.oid), changes: lineCount(repo, base.oid) });
    } else if (!base && head) {
      const adds = lineCount(repo, head.oid);
      out.push({ filename: path, status: 'added', additions: adds, deletions: 0, changes: adds });
    } else if (base && head && base.oid !== head.oid) {
      const diff = lineDiff(repo, base.oid, head.oid);
      out.push({ filename: path, status: 'modified', additions: diff.additions, deletions: diff.deletions, changes: diff.additions + diff.deletions });
    }
  }
  return out;
}

function lineCount(repo: Repo, oid: string): number {
  const obj = getObject(repo, oid);
  if (!obj) return 0;
  const text = obj.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function lineDiff(repo: Repo, oldOid: string, newOid: string): { additions: number; deletions: number } {
  const oldObj = getObject(repo, oldOid);
  const newObj = getObject(repo, newOid);
  const oldLines = oldObj ? oldObj.data.toString('utf8').split('\n') : [];
  const newLines = newObj ? newObj.data.toString('utf8').split('\n') : [];
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  // Small LCS diff; files in the suite are a few KiB at most.
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: n - common, deletions: m - common };
}

// A pull request conflicts when a path it changes was also changed on the
// base branch after their merge base.
function prConflict(repo: Repo, pr: PullRequest): boolean {
  if (pr.state !== 'open') return false;
  // The base tip is the live ref: the base branch may have advanced since
  // the pull request was opened (e.g. another PR merged first).
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  const baseSha = mergeBase(repo, pr.headSha, baseTip);
  if (baseSha === null) return false;
  const baseFiles = commitFilesAt(repo, baseSha);
  const headFiles = commitFilesAt(repo, pr.headSha);
  const tipFiles = commitFilesAt(repo, baseTip);
  const changed = new Set<string>();
  for (const path of new Set([...baseFiles.keys(), ...headFiles.keys()])) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if ((b?.oid ?? null) !== (h?.oid ?? null)) changed.add(path);
  }
  for (const path of changed) {
    const b = baseFiles.get(path);
    const t = tipFiles.get(path);
    if ((b?.oid ?? null) !== (t?.oid ?? null)) return true;
  }
  return false;
}

function squashMerge(repo: Repo, pr: PullRequest): { sha: string; conflict: boolean } {
  if (prConflict(repo, pr)) return { sha: '', conflict: true };
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  const baseSha = mergeBase(repo, pr.headSha, baseTip) ?? baseTip;
  const baseFiles = commitFilesAt(repo, baseTip);
  const headFiles = commitFilesAt(repo, pr.headSha);
  const mergeBaseFiles = commitFilesAt(repo, baseSha);
  // Apply the head's changes relative to the merge base onto the base tip.
  const mergedFiles = new Map(baseFiles);
  for (const path of new Set([...mergeBaseFiles.keys(), ...headFiles.keys()])) {
    const atBase = mergeBaseFiles.get(path);
    const atHead = headFiles.get(path);
    if ((atBase?.oid ?? null) === (atHead?.oid ?? null)) continue;
    if (atHead === undefined) mergedFiles.delete(path);
    else mergedFiles.set(path, atHead);
  }
  const tree = treeFromFiles(repo, mergedFiles);
  const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.headRef}\n\n${pr.title}`;
  const commit = putObject(repo, 'commit', buildCommit(tree, [baseTip], message));
  repo.refs.set(`refs/heads/${pr.baseRef}`, commit);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = FIXED_ISO;
  pr.mergeCommitSha = commit;
  pr.baseSha = commit;
  return { sha: commit, conflict: false };
}

function createIssueIn(repo: Repo, title: string, body: string, labels: string[]): Issue {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    number,
    globalId: gid('Issue', `${repo.dbId}:${number}`),
    title: title ?? '',
    body: body ?? '',
    state: 'open',
    labels: [...labels],
    seq: nextNumericId(),
    comments: [],
  };
  repo.issues.push(issue);
  return issue;
}

function createPullIn(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | null {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pr: PullRequest = {
    number,
    globalId: gid('PullRequest', `${repo.dbId}:${number}`),
    title: title ?? '',
    body: body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    seq: nextNumericId(),
  };
  repo.pulls.push(pr);
  return pr;
}

// Commit one file change on a branch (creating the branch when needed).
function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; blobSha: string } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const files = tip !== undefined ? commitFilesAt(repo, tip) : new Map<string, { oid: string; mode: string }>();
  const blobSha = putObject(repo, 'blob', content);
  files.set(path, { oid: blobSha, mode: '100644' });
  const tree = treeFromFiles(repo, files);
  const parents = tip !== undefined ? [tip] : [];
  const commitSha = putObject(repo, 'commit', buildCommit(tree, parents, message || 'Update file'));
  repo.refs.set(ref, commitSha);
  return { commitSha, blobSha };
}

// ---------------------------------------------------------------- REST router

type JsonObj = Record<string, unknown>;

function asObj(value: unknown): JsonObj | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObj) : null;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry);
    else if (asObj(entry) && typeof (entry as JsonObj).name === 'string') out.push((entry as JsonObj).name as string);
  }
  return out;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, segs: string[]): Promise<boolean> {
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  // Only /api/v3 lives here.
  if (segs[0] !== 'api' || segs[1] !== 'v3') return false;
  const rest = segs.slice(2);

  // Public roots: no token needed.
  if (method === 'GET' && rest.length === 0) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    sendJson(res, 200, { installed_version: VERSION, version: VERSION, verifiable_password_authentication: false }, { 'x-oauth-scopes': 'repo' });
    return true;
  }

  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return true;
  }

  // Parse a JSON body when one is present.
  let body: unknown = undefined;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        errJson(res, 400, 'Problems parsing JSON');
        return true;
      }
    }
  }
  const payload = asObj(body) ?? {};

  // GET /user
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: 1000, node_id: gid('User', VIEWER_LOGIN), name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User', avatar_url: '' });
    return true;
  }

  // /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, b) => a.seq - b.seq).map(repoJson);
      const { page, link } = paginate(all, query, req, '/api/v3/user/repos');
      const headers: Record<string, string> = {};
      if (link) headers.link = link;
      sendJson(res, 200, page, headers);
      return true;
    }
    if (method === 'POST') {
      const name = str(payload.name);
      if (name === '') {
        errJson(res, 422, 'Validation Failed: name is required');
        return true;
      }
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        errJson(res, 422, 'Validation Failed: invalid repository name');
        return true;
      }
      if (findRepo(VIEWER_LOGIN, name)) {
        errJson(res, 422, 'Validation Failed: name already exists on this account');
        return true;
      }
      const repo = createRepo(name, payload.private === true, str(payload.description));
      sendJson(res, 201, repoJson(repo));
      return true;
    }
  }

  // /repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const name = rest[2]!;
    const repo = findRepo(owner, name);
    if (!repo) {
      errJson(res, 404, 'Not Found');
      return true;
    }
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof payload.description === 'string') repo.description = payload.description;
        if (typeof payload.private === 'boolean') repo.isPrivate = payload.private;
        if (typeof payload.name === 'string' && payload.name !== '' && payload.name !== repo.name) {
          repos.delete(repoKey(repo.owner, repo.name));
          repo.name = payload.name as string;
          repos.set(repoKey(repo.owner, repo.name), repo);
        }
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(repo.owner, repo.name));
        sendJson(res, 204, null);
        return true;
      }
    }

    if (tail.length === 1 && tail[0] === 'branches' && method === 'GET') {
      const list = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` }, protected: false }));
      sendJson(res, 200, list);
      return true;
    }

    if (tail.length === 2 && tail[0] === 'branches' && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${tail[1]}`);
      if (sha === undefined) {
        errJson(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { name: tail[1], commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` }, protected: false });
      return true;
    }

    if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
      const refName = query.get('sha') ?? repo.defaultBranch;
      let tip = repo.refs.get(`refs/heads/${refName}`);
      if (tip === undefined && /^[0-9a-f]{40}$/i.test(refName)) tip = refName;
      if (tip === undefined) {
        sendJson(res, 200, []);
        return true;
      }
      const { page } = pageParams(query);
      const history = commitHistory(repo, tip, 100);
      const list = history.map((sha) => {
        const obj = getObject(repo, sha)!;
        const info = parseCommit(obj.data);
        return {
          sha,
          commit: {
            // parseCommit keeps the stored trailing newline; the REST
            // view answers the message without it.
            message: info.message.replace(/\n$/, ''),
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
            tree: { sha: info.tree },
          },
          author: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
          committer: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
          parents: info.parents.map((p) => ({ sha: p })),
        };
      });
      void page;
      sendJson(res, 200, list);
      return true;
    }

    // Git Data API: refs
    if (tail.length >= 2 && tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = str(payload.ref);
        const sha = str(payload.sha);
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha) || !getObject(repo, sha)) {
          errJson(res, 422, 'Validation Failed: invalid ref or sha');
          return true;
        }
        if (repo.refs.has(ref)) {
          errJson(res, 422, 'Validation Failed: Reference already exists');
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: gid('Ref', `${repo.dbId}:${ref}`), url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.replace('refs/', '')}`, object: { sha, type: getObject(repo, sha)?.type ?? 'commit', url: '' } });
        return true;
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = `refs/${tail.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { ref, node_id: gid('Ref', `${repo.dbId}:${ref}`), url: `/api/v3/repos/${owner}/${name}/git/refs/${tail.slice(2).join('/')}`, object: { sha, type: getObject(repo, sha)?.type ?? 'commit', url: '' } });
        return true;
      }
      if (method === 'GET' && tail.length === 2) {
        const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: getObject(repo, sha)?.type ?? 'commit' } }));
        sendJson(res, 200, list);
        return true;
      }
    }

    // Contents
    if (tail.length >= 1 && tail[0] === 'contents') {
      const contentPath = tail.slice(1).join('/');
      if (method === 'GET') {
        const refName = query.get('ref') ?? repo.defaultBranch;
        let tip = repo.refs.get(`refs/heads/${refName}`);
        if (tip === undefined && /^[0-9a-f]{40}$/i.test(refName)) tip = refName;
        if (tip === undefined) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const files = commitFilesAt(repo, tip);
        if (contentPath === '') {
          sendJson(res, 200, dirListing(repo, files, ''));
          return true;
        }
        const file = files.get(contentPath);
        if (file) {
          const obj = getObject(repo, file.oid)!;
          const content = b64encode(obj.data);
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: obj.data.length, name: contentPath.split('/').pop(),
            path: contentPath, content: content.replace(/(.{60})/g, '$1\n'), sha: file.oid,
            url: `/api/v3/repos/${owner}/${name}/contents/${contentPath}`,
            html_url: `https://github.com/${owner}/${name}/blob/${refName}/${contentPath}`,
          });
          return true;
        }
        const prefix = `${contentPath}/`;
        const hasChildren = [...files.keys()].some((p) => p.startsWith(prefix));
        if (hasChildren) {
          sendJson(res, 200, dirListing(repo, files, contentPath));
          return true;
        }
        errJson(res, 404, 'Not Found');
        return true;
      }
      if (method === 'PUT') {
        const branch = str(payload.branch, repo.defaultBranch);
        const message = str(payload.message, 'Update file');
        const contentB64 = str(payload.content);
        if (contentB64 === '') {
          errJson(res, 422, 'Validation Failed: content is required');
          return true;
        }
        const content = b64decode(contentB64);
        const ref = `refs/heads/${branch}`;
        const tip = repo.refs.get(ref);
        const files = tip !== undefined ? commitFilesAt(repo, tip) : new Map<string, { oid: string; mode: string }>();
        const existing = files.get(contentPath);
        const isUpdate = existing !== undefined;
        if (isUpdate && typeof payload.sha === 'string' && payload.sha !== existing!.oid) {
          errJson(res, 409, 'Conflict: sha does not match the current file');
          return true;
        }
        const { commitSha, blobSha } = commitFile(repo, branch, contentPath, content, message);
        sendJson(res, isUpdate ? 200 : 201, {
          content: { name: contentPath.split('/').pop(), path: contentPath, sha: blobSha, size: content.length, encoding: 'base64', type: 'file' },
          commit: { sha: commitSha, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const branch = str(payload.branch, repo.defaultBranch);
        const ref = `refs/heads/${branch}`;
        const tip = repo.refs.get(ref);
        if (tip === undefined) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        const files = commitFilesAt(repo, tip);
        const existing = files.get(contentPath);
        if (!existing) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        files.delete(contentPath);
        const tree = treeFromFiles(repo, files);
        const commitSha = putObject(repo, 'commit', buildCommit(tree, [tip], str(payload.message, 'Delete file')));
        repo.refs.set(ref, commitSha);
        sendJson(res, 200, { commit: { sha: commitSha } });
        return true;
      }
    }

    // Labels
    if (tail.length === 1 && tail[0] === 'labels') {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
        return true;
      }
      if (method === 'POST') {
        const name = str(payload.name);
        if (name === '') {
          errJson(res, 422, 'Validation Failed: name is required');
          return true;
        }
        if (repo.labels.has(name)) {
          errJson(res, 422, 'Validation Failed: label already exists');
          return true;
        }
        const color = str(payload.color, 'ededed');
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { name, color, description: '' });
        return true;
      }
    }

    // Issues
    if (tail.length >= 1 && tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const { page, link } = paginate(list.map((i) => issueJson(repo, i)), query, req, `/api/v3/repos/${owner}/${name}/issues`);
          const headers: Record<string, string> = {};
          if (link) headers.link = link;
          sendJson(res, 200, page, headers);
          return true;
        }
        if (method === 'POST') {
          const title = str(payload.title);
          if (title === '') {
            errJson(res, 422, 'Validation Failed: title is required');
            return true;
          }
          const labels = labelNames(payload.labels);
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              errJson(res, 422, `Validation Failed: label "${label}" does not exist`);
              return true;
            }
          }
          const issue = createIssueIn(repo, title, str(payload.body), labels);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
      }
      const issueNumber = Number(tail[1]);
      const issue = repo.issues.find((i) => i.number === issueNumber);
      if (tail.length === 2) {
        if (!issue) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          if (typeof payload.state === 'string' && (payload.state === 'open' || payload.state === 'closed')) issue.state = payload.state;
          if (typeof payload.title === 'string') issue.title = payload.title;
          if (typeof payload.body === 'string') issue.body = payload.body;
          if (payload.labels !== undefined) {
            const labels = labelNames(payload.labels);
            for (const label of labels) {
              if (!repo.labels.has(label)) {
                errJson(res, 422, `Validation Failed: label "${label}" does not exist`);
                return true;
              }
            }
            issue.labels = labels;
          }
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: c.globalId, body: c.body, user: { login: VIEWER_LOGIN, id: 1000, type: 'User' }, created_at: FIXED_ISO, updated_at: FIXED_ISO })));
          return true;
        }
        if (method === 'POST') {
          const commentBody = str(payload.body);
          if (commentBody === '') {
            errJson(res, 422, 'Validation Failed: body is required');
            return true;
          }
          const id = nextNumericId();
          const comment: Comment = { id, globalId: gid('IssueComment', `${repo.dbId}:${issue.number}:${id}`), body: commentBody };
          issue.comments.push(comment);
          sendJson(res, 201, { id, node_id: comment.globalId, body: commentBody, user: { login: VIEWER_LOGIN, id: 1000, type: 'User' }, created_at: FIXED_ISO, updated_at: FIXED_ISO });
          return true;
        }
      }
    }

    // Pull requests
    if (tail.length >= 1 && tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          const { page, link } = paginate(list.map((p) => pullJson(repo, p)), query, req, `/api/v3/repos/${owner}/${name}/pulls`);
          const headers: Record<string, string> = {};
          if (link) headers.link = link;
          sendJson(res, 200, page, headers);
          return true;
        }
        if (method === 'POST') {
          const title = str(payload.title);
          const headRaw = str(payload.head);
          const baseRaw = str(payload.base);
          const head = headRaw.includes(':') ? headRaw.split(':').slice(1).join(':') : headRaw;
          const base = baseRaw.includes(':') ? baseRaw.split(':').slice(1).join(':') : baseRaw;
          if (title === '' || head === '' || base === '') {
            errJson(res, 422, 'Validation Failed: title, head and base are required');
            return true;
          }
          if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
            errJson(res, 422, 'Validation Failed: head or base branch does not exist');
            return true;
          }
          if (repo.pulls.some((p) => p.state === 'open' && p.headRef === head && p.baseRef === base)) {
            errJson(res, 422, 'Validation Failed: a pull request already exists for this head branch');
            return true;
          }
          const pr = createPullIn(repo, title, str(payload.body), head, base);
          if (!pr) {
            errJson(res, 422, 'Validation Failed: could not create pull request');
            return true;
          }
          sendJson(res, 201, pullJson(repo, pr));
          return true;
        }
      }
      const prNumber = Number(tail[1]);
      const pr = repo.pulls.find((p) => p.number === prNumber);
      if (tail.length === 2) {
        if (!pr) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pr));
          return true;
        }
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (!pr) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, prFiles(repo, pr).map((f) => ({ ...f, sha: '', blob_url: '', raw_url: '', patch: '' })));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (!pr) {
          errJson(res, 404, 'Not Found');
          return true;
        }
        if (pr.state !== 'open') {
          errJson(res, 405, 'Pull request is already closed');
          return true;
        }
        const result = squashMerge(repo, pr);
        if (result.conflict) {
          errJson(res, 405, 'Merge conflict: the pull request cannot be merged');
          return true;
        }
        sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
    }
  }

  errJson(res, 404, 'Not Found');
  return true;
}

function dirListing(repo: Repo, files: Map<string, { oid: string; mode: string }>, dir: string): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Map<string, { type: string; sha: string }>();
  for (const [path, value] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      entries.set(rest, { type: 'file', sha: value.oid });
    } else {
      const dirName = rest.slice(0, slash);
      if (!entries.has(dirName)) {
        // The directory's tree sha: rebuild the subtree hash from the files.
        const subFiles = new Map<string, { oid: string; mode: string }>();
        for (const [p, v] of files) if (p.startsWith(`${prefix}${dirName}/`)) subFiles.set(p.slice(prefix.length + dirName.length + 1), v);
        entries.set(dirName, { type: 'dir', sha: treeFromFiles(repo, subFiles) });
      }
    }
  }
  return [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, entry]) => ({
      type: entry.type,
      name,
      path: prefix + name,
      sha: entry.sha,
      size: entry.type === 'file' ? (getObject(repo, entry.sha)?.data.length ?? 0) : 0,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${prefix}${name}`,
    }));
}

// ---------------------------------------------------------------- git smart HTTP

function v0Capabilities(repo: Repo, service: 'upload' | 'receive'): string {
  const common = 'side-band-64k thin-pack ofs-delta agent=forge/1.0.0';
  if (service === 'upload') return `${common} multi_ack_detailed shallow symref=HEAD:refs/heads/${repo.defaultBranch}`;
  return `${common} report-status delete-refs`;
}

function refLines(repo: Repo): Array<{ oid: string; name: string }> {
  const lines: Array<{ oid: string; name: string }> = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  lines.push({ oid: headTip ?? ZERO_OID, name: 'HEAD' });
  for (const [ref, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push({ oid, name: ref });
  }
  return lines;
}

function v0Advertisement(repo: Repo, service: 'upload' | 'receive'): Buffer {
  const serviceName = service === 'upload' ? 'git-upload-pack' : 'git-receive-pack';
  const parts: Buffer[] = [pktLine(`# service=${serviceName}\n`), pktFlush()];
  const caps = v0Capabilities(repo, service);
  if (repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const refs = refLines(repo);
    refs.forEach((ref, index) => {
      if (index === 0) parts.push(pktLine(`${ref.oid} ${ref.name}\0${caps}\n`));
      else parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    });
    // Peeled tags after their tag line.
    const peeled: Buffer[] = [];
    for (const [refName, oid] of repo.refs) {
      if (!refName.startsWith('refs/tags/')) continue;
      const obj = getObject(repo, oid);
      if (obj?.type === 'tag') {
        const target = parseTag(obj.data).object;
        peeled.push(pktLine(`${target} ${refName}^{}\n`));
      }
    }
    parts.push(...peeled);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

function lsRefsLines(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean, unborn: boolean): Buffer {
  const parts: Buffer[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const emit = (oid: string, name: string, attrs: string): void => {
    if (!keep(name)) return;
    parts.push(pktLine(`${oid} ${name}${attrs}\n`));
  };
  if (headTip === undefined) {
    if (unborn && keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}\n`));
    }
  } else {
    emit(headTip, 'HEAD', symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : '');
  }
  for (const [ref, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let attrs = '';
    if (peel) {
      const obj = getObject(repo, oid);
      if (obj?.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled) attrs += ` peeled:${peeled}`;
      }
    }
    emit(oid, ref, attrs);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// Build the object set for a fetch: wants minus the have closure, honoring
// a commit-depth limit and the client's shallow boundaries.
function fetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | undefined,
): { objects: Set<string>; shallow: string[]; unshallow: string[] } {
  const stopAt = new Set(shallowBoundaries);
  const haveReach = reachableObjects(repo, haves, { stopAt });
  const wantReach = reachableObjects(repo, wants, {
    maxCommitDepth: depth,
    stopAt: new Set(),
  });
  const objects = new Set<string>();
  for (const oid of wantReach.objects) if (!haveReach.objects.has(oid)) objects.add(oid);
  // Boundary commits of the depth-limited walk that still have parents.
  const shallow: string[] = [];
  for (const oid of wantReach.boundary) {
    if (objects.has(oid)) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const boundary of shallowBoundaries) {
    const peeled = peelToCommit(repo, boundary);
    if (peeled && wantReach.objects.has(peeled) && !shallow.includes(peeled)) {
      // The old boundary is now fully included (its parents arrived).
      const obj = getObject(repo, peeled);
      if (obj?.type === 'commit') {
        const parents = parseCommit(obj.data).parents;
        const parentsIncluded = parents.every((p) => wantReach.objects.has(p) || haveReach.objects.has(p));
        if (parentsIncluded) unshallow.push(peeled);
      }
    }
  }
  return { objects, shallow, unshallow };
}

// The v2 fetch response. Per the protocol (and git's fetch-pack state
// machine), the acknowledgments section is only sent while the client is
// still negotiating: once the client sent "done" the response goes straight
// to shallow-info / packfile, and a response to a request without "done"
// carries acknowledgments plus a flush and no packfile.
function v2FetchResponse(repo: Repo, req: { wants: string[]; haves: string[]; shallow: string[]; depth?: number; done?: boolean }): Buffer {
  const { objects, shallow, unshallow } = fetchObjects(repo, req.wants, req.haves, req.shallow, req.depth);
  const parts: Buffer[] = [];
  if (req.done !== true && req.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const common = req.haves.filter((have) => getObject(repo, have) !== undefined);
    if (common.length > 0) {
      for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  if (objects.size > 0) {
    const pack = buildPack(repo, objects);
    parts.push(sidebandPacket(1, pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: Repo, req: { wants: string[]; haves: string[]; shallow: string[]; depth?: number }): Buffer {
  const { objects, shallow, unshallow } = fetchObjects(repo, req.wants, req.haves, req.shallow, req.depth);
  const parts: Buffer[] = [];
  const allHave = req.wants.every((w) => req.haves.includes(w));
  if (allHave && req.wants.length > 0) {
    for (const want of req.wants) parts.push(pktLine(`ACK ${want}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (objects.size > 0) {
    const pack = buildPack(repo, objects);
    parts.push(sidebandPacket(1, pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, segs: string[]): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (segs.length < 2) return false;
  // Route shape: /{owner}/{repo}.git/info/refs or /{owner}/{repo}.git/git-upload-pack etc.
  const dotGitIndex = segs.findIndex((s) => s.endsWith('.git'));
  if (dotGitIndex < 1) return false;
  const owner = segs.slice(0, dotGitIndex).join('/');
  const repoName = segs[dotGitIndex]!.slice(0, -4);
  const repo = findRepo(owner, repoName);
  const tail = segs.slice(dotGitIndex + 1);
  const query = queryOf(req);
  const service = query.get('service') ?? '';

  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    if (!repo) {
      sendRaw(res, 404, Buffer.from('Not Found\n'), 'text/plain');
      return true;
    }
    const wantV2 = req.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
    if (service === 'git-upload-pack') {
      if (wantV2) {
        sendRaw(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      } else {
        sendRaw(res, 200, v0Advertisement(repo, 'upload'), 'application/x-git-upload-pack-advertisement');
      }
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, v0Advertisement(repo, 'receive'), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    sendRaw(res, 400, Buffer.from('Bad Request\n'), 'text/plain');
    return true;
  }

  if (method === 'POST' && tail.length === 1 && (tail[0] === 'git-upload-pack' || tail[0] === 'git-receive-pack')) {
    if (!repo) {
      sendRaw(res, 404, Buffer.from('Not Found\n'), 'text/plain');
      return true;
    }
    const raw = await readBody(req);
    if (tail[0] === 'git-upload-pack') {
      const isV2 = req.headers['git-protocol'] === 'version=2';
      const packets = decodePktLines(raw);
      const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
      if (isV2) {
        const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length);
        if (command === 'ls-refs') {
          const prefixes: string[] = [];
          let peel = false;
          let symrefs = false;
          let unborn = false;
          for (const line of lines) {
            if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
            else if (line === 'peel') peel = true;
            else if (line === 'symrefs') symrefs = true;
            else if (line === 'unborn') unborn = true;
          }
          sendRaw(res, 200, lsRefsLines(repo, prefixes, peel, symrefs, unborn), 'application/x-git-upload-pack-result');
          return true;
        }
        if (command === 'fetch') {
          const wants: string[] = [];
          const haves: string[] = [];
          const shallow: string[] = [];
          let depth: number | undefined;
          let done = false;
          for (const line of lines) {
            if (line.startsWith('want ')) wants.push(line.slice(5).trim());
            else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
            else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
            else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
            else if (line === 'done') done = true;
          }
          sendRaw(res, 200, v2FetchResponse(repo, { wants, haves, shallow, depth, done }), 'application/x-git-upload-pack-result');
          return true;
        }
        sendRaw(res, 400, Buffer.from('Bad Request\n'), 'text/plain');
        return true;
      }
      // v0 fetch: wants section, flush, haves + done, flush.
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | undefined;
      let inSecondSection = false;
      for (const packet of packets) {
        if (packet.kind === 'flush') {
          inSecondSection = true;
          continue;
        }
        if (packet.kind !== 'data') continue;
        const line = packet.payload.toString('utf8').replace(/\n$/, '');
        if (line.startsWith('want ')) {
          const rest = line.slice(5);
          const space = rest.indexOf(' ');
          wants.push(space === -1 ? rest : rest.slice(0, space));
        } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
        void inSecondSection;
      }
      sendRaw(res, 200, v0FetchResponse(repo, { wants, haves, shallow, depth }), 'application/x-git-upload-pack-result');
      return true;
    }

    // receive-pack (v0): command list, flush, packfile.
    const packets = decodePktLines(raw);
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    let packStart = -1;
    let offset = 0;
    // Re-scan the raw buffer to find where the pkt-line command section ends:
    // decodePktLines consumed the command lines; the pack begins right after
    // the flush packet that ends them.
    {
      let pos = 0;
      let sectionEnd = -1;
      while (pos + 4 <= raw.length) {
        const len = parseInt(raw.subarray(pos, pos + 4).toString('ascii'), 16);
        if (Number.isNaN(len)) break;
        if (len === 0) {
          sectionEnd = pos + 4;
          break;
        }
        if (len < 4) break;
        const payload = raw.subarray(pos + 4, pos + len).toString('utf8');
        const nul = payload.indexOf('\0');
        const line = (nul === -1 ? payload : payload.slice(0, nul)).replace(/\n$/, '');
        const parts = line.split(' ');
        if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
        pos += len;
      }
      packStart = sectionEnd;
    }
    void offset;
    void packets;
    let entries: PackEntry[] = [];
    let unpackOk = true;
    if (packStart >= 0 && packStart < raw.length && raw.subarray(packStart, packStart + 4).toString('ascii') === 'PACK') {
      try {
        entries = parsePack(raw.subarray(packStart), repo);
      } catch (err) {
        unpackOk = false;
      }
    } else if (packStart >= 0 && packStart < raw.length) {
      // A pack that does not start with PACK is corrupt.
      unpackOk = false;
    }
    if (unpackOk) {
      for (const entry of entries) putObject(repo, entry.type, entry.data);
    }
    // Apply the ref updates, fast-forward only, in command order.
    const reportLines: string[] = [unpackOk ? 'unpack ok' : 'unpack error'];
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (!unpackOk) {
        reportLines.push(`ng ${command.ref} unpack failed`);
        continue;
      }
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined || current === command.oldOid || command.oldOid === ZERO_OID) {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}`);
        } else {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
        }
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
        continue;
      }
      if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      const newCommit = peelToCommit(repo, command.newOid);
      const oldCommit = peelToCommit(repo, current);
      if (newCommit === null || oldCommit === null) {
        // Non-commit refs (e.g. a tag update): allow when the old value matches.
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
        continue;
      }
      if (isAncestor(repo, oldCommit, newCommit)) {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
      } else {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      }
    }
    const reportBody = Buffer.concat(reportLines.map((line) => pktLine(`${line}\n`)));
    // The flush that ends the report must ride *inside* the band-1 data:
    // git demultiplexes the sideband stream into a pipe and its packet
    // reader expects a flush pkt-line there (real receive-pack does
    // packet_buf_flush before send_sideband). The trailing wire-level flush
    // then ends the sideband stream itself.
    const response = Buffer.concat([sidebandPacket(1, Buffer.concat([reportBody, pktFlush()])), pktFlush()]);
    sendRaw(res, 200, response, 'application/x-git-receive-pack-result');
    return true;
  }

  return false;
}

// ---------------------------------------------------------------- GraphQL

const GQL_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'mergedAt', 'createdAt', 'url', 'headRefOid', 'baseRefOid', 'author'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes', 'status'],
  Ref: ['name', 'target'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType'],
  IssueComment: ['id', 'body', 'author'],
  Node: ['id'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  AddCommentEdge: ['node'],
};

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'mergedAt', 'createdAt', 'url', 'headRefOid', 'baseRefOid', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'],
  User: ['login', 'id', 'name', 'email'],
  IssueState: [],
  PullRequestState: [],
  SearchType: [],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
};

const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

type GqlValue =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

interface GqlSelection {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[] | null;
  fragmentType: string | null;
  fragmentName: string | null;
}

interface GqlOperation {
  kind: string;
  name: string | null;
  variables: Record<string, GqlValue>;
  selections: GqlSelection[];
}

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s|,/.test(ch)) { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '.' && src.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if ('{}():$!=[]@'.includes(ch)) { tokens.push(ch); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;
  fragments = new Map<string, { type: string; selections: GqlSelection[] }>();

  constructor(src: string) {
    this.tokens = gqlTokenize(src);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    return this.tokens[this.pos++] ?? '';
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        const type = this.next();
        const selections = this.parseSelectionSet();
        this.fragments.set(name, { type, selections });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): GqlOperation {
    let kind = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token === 'query' || token === 'mutation' || token === 'subscription') {
      kind = this.next();
      if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
    }
    const variables: Record<string, GqlValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        if (this.peek() === '$') {
          this.next();
          const varName = this.next();
          this.expect(':');
          // Skip the type (may include [ ] ! and a name).
          while (this.peek() !== undefined && this.peek() !== ')' && this.peek() !== ',' && this.peek() !== '$' && this.peek() !== '=') this.next();
          if (this.peek() === '=') {
            this.next();
            variables[varName] = this.parseValue();
          }
        } else {
          this.next();
        }
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const type = this.next();
        const selections = this.parseSelectionSet();
        return { alias: null, name: '', args: {}, selections, fragmentType: type, fragmentName: null };
      }
      const fragName = this.next();
      return { alias: null, name: '', args: {}, selections: null, fragmentType: null, fragmentName: fragName };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    let selections: GqlSelection[] | null = null;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { alias, name, args, selections, fragmentType: null, fragmentName: null };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d+\.\d+$/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string': return value.value;
    case 'int': case 'float': return value.value;
    case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'variable': return variables[value.name] ?? null;
    case 'list': return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value.fields)) out[key] = resolveValue(entry, variables);
      return out;
    }
  }
}

interface GqlParent {
  type: string;
  value: unknown;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issueStateGql(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prStateGql(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prMergeableGql(repo: Repo, pr: PullRequest): string {
  if (pr.merged) return 'MERGEABLE';
  return prConflict(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
}

function executeGqlSelections(
  parent: GqlParent,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
  errors: Array<{ message: string }>,
  parser: GqlParser,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.fragmentName !== null) {
      const fragment = parser.fragments.get(selection.fragmentName);
      if (!fragment) continue;
      const effectiveType = parent.type === 'Node' ? (parent.value as { __typename?: string }).__typename ?? parent.type : parent.type;
      if (fragment.type !== effectiveType) continue;
      Object.assign(out, executeGqlSelections({ type: effectiveType, value: parent.value }, fragment.selections, variables, errors, parser));
      continue;
    }
    if (selection.fragmentType !== null) {
      const effectiveType = parent.type === 'Node' ? (parent.value as { __typename?: string }).__typename ?? '' : parent.type;
      if (selection.fragmentType !== effectiveType) continue;
      Object.assign(out, executeGqlSelections({ type: effectiveType, value: parent.value }, selection.selections ?? [], variables, errors, parser));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const known = GQL_FIELDS[parent.type] ?? [];
    if (!known.includes(selection.name)) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${parent.type}".` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of Object.entries(selection.args)) args[argName] = resolveValue(argValue, variables);
    out[key] = executeGqlField(parent, selection, args, variables, errors, parser);
  }
  return out;
}

function executeGqlField(
  parent: GqlParent,
  selection: GqlSelection,
  args: Record<string, unknown>,
  variables: Record<string, unknown>,
  errors: Array<{ message: string }>,
  parser: GqlParser,
): unknown {
  const field = selection.name;
  const sub = selection.selections ?? [];
  const child = (type: string, value: unknown): unknown => {
    if (value === null || value === undefined) return null;
    if (sub.length === 0) return value;
    return executeGqlSelections({ type, value }, sub, variables, errors, parser);
  };
  const val = parent.value as Record<string, unknown>;

  if (parent.type === 'Query') {
    if (field === 'viewer') return child('User', { __typename: 'User', login: VIEWER_LOGIN });
    if (field === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = owner === VIEWER_LOGIN ? findRepo(owner, name) : undefined;
      if (!repo) return null;
      return child('Repository', { __typename: 'Repository', repo });
    }
    if (field === 'node') {
      const decoded = decodeGid(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = [...repos.values()].find((r) => r.dbId === Number(decoded.key));
        if (!repo) return null;
        return child('Node', { __typename: 'Repository', repo, id: repo.globalId });
      }
      if (decoded.kind === 'Issue') {
        const [dbId, number] = decoded.key.split(':');
        const repo = [...repos.values()].find((r) => r.dbId === Number(dbId));
        const issue = repo?.issues.find((i) => i.number === Number(number));
        if (!repo || !issue) return null;
        return child('Node', { __typename: 'Issue', repo, issue, id: issue.globalId });
      }
      if (decoded.kind === 'PullRequest') {
        const [dbId, number] = decoded.key.split(':');
        const repo = [...repos.values()].find((r) => r.dbId === Number(dbId));
        const pr = repo?.pulls.find((p) => p.number === Number(number));
        if (!repo || !pr) return null;
        return child('Node', { __typename: 'PullRequest', repo, pr, id: pr.globalId });
      }
      return null;
    }
    if (field === '__type') {
      const name = String(args.name ?? '');
      const fields = GQL_TYPE_FIELDS[name];
      const enumValues = GQL_ENUM_VALUES[name];
      if (fields === undefined && enumValues === undefined) return null;
      return child('__Type', { __typename: '__Type', typeName: name, fields: fields ?? [], enumValues: enumValues ?? [] });
    }
    if (field === '__schema') {
      return child('__Schema', { __typename: '__Schema' });
    }
    return null;
  }

  if (parent.type === 'Node') {
    if (field === 'id') return String(val.id ?? '');
    return null;
  }

  if (parent.type === 'User') {
    if (field === 'login') return VIEWER_LOGIN;
    if (field === 'id') return gid('User', VIEWER_LOGIN);
    if (field === 'name') return VIEWER_NAME;
    if (field === 'email') return VIEWER_EMAIL;
    return null;
  }

  if (parent.type === 'Repository') {
    const repo = val.repo as Repo;
    switch (field) {
      case 'id': return repo.globalId;
      case 'databaseId': return repo.dbId;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return child('User', { __typename: 'User', login: repo.owner });
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return child('Ref', { __typename: 'Ref', name: repo.defaultBranch, sha: tip });
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'private': return repo.isPrivate;
      case 'url': return `https://github.com/${repo.owner}/${repo.name}`;
      case 'createdAt': case 'updatedAt': return FIXED_ISO;
      case 'issue': {
        const issue = repo.issues.find((i) => i.number === Number(args.number));
        if (!issue) return null;
        return child('Issue', { __typename: 'Issue', repo, issue });
      }
      case 'issues': {
        let list = [...repo.issues];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          list = list.filter((i) => states.includes(issueStateGql(i)));
        }
        const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
        const direction = orderBy?.direction ?? 'ASC';
        list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
        const afterNumber = numberFromCursor(args.after);
        if (afterNumber !== null) {
          list = direction === 'DESC' ? list.filter((i) => i.number < afterNumber) : list.filter((i) => i.number > afterNumber);
        }
        const first = typeof args.first === 'number' ? args.first : list.length;
        const pageItems = list.slice(0, first);
        const hasNext = list.length > first;
        const endCursor = pageItems.length > 0 ? cursorFor(pageItems[pageItems.length - 1]!.number) : null;
        return child('IssueConnection', {
          __typename: 'IssueConnection',
          repo,
          nodes: pageItems,
          pageInfo: { hasNextPage: hasNext, endCursor, hasPreviousPage: afterNumber !== null, startCursor: pageItems.length > 0 ? cursorFor(pageItems[0]!.number) : null },
          totalCount: list.length,
        });
      }
      case 'pullRequests': {
        let list = [...repo.pulls];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          list = list.filter((p) => states.includes(prStateGql(p)));
        } else {
          list = list.filter((p) => p.state === 'open');
        }
        const first = typeof args.first === 'number' ? args.first : list.length;
        const pageItems = list.slice(0, first);
        return child('PullRequestConnection', {
          __typename: 'PullRequestConnection',
          repo,
          nodes: pageItems,
          pageInfo: { hasNextPage: list.length > first, endCursor: pageItems.length > 0 ? cursorFor(pageItems[pageItems.length - 1]!.number) : null, hasPreviousPage: false, startCursor: null },
          totalCount: list.length,
        });
      }
      case 'pullRequest': {
        const pr = repo.pulls.find((p) => p.number === Number(args.number));
        if (!pr) return null;
        return child('PullRequest', { __typename: 'PullRequest', repo, pr });
      }
      default: return null;
    }
  }

  if (parent.type === 'Issue') {
    const issue = val.issue as Issue;
    const repo = val.repo as Repo;
    switch (field) {
      case 'id': return issue.globalId;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issueStateGql(issue);
      case 'body': return issue.body;
      case 'url': return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'createdAt': case 'updatedAt': return FIXED_ISO;
      case 'closedAt': return issue.state === 'closed' ? FIXED_ISO : null;
      case 'author': return child('User', { __typename: 'User', login: VIEWER_LOGIN });
      case 'labels': return { nodes: issue.labels.map((name) => ({ name })) };
      case 'comments': return { nodes: issue.comments.map((c) => ({ id: c.globalId, body: c.body })) };
      case 'repository': return child('Repository', { __typename: 'Repository', repo });
      default: return null;
    }
  }

  if (parent.type === 'IssueConnection') {
    if (field === 'nodes') {
      const nodes = val.nodes as Issue[];
      const repo = val.repo as Repo;
      return nodes.map((issue) => executeGqlSelections({ type: 'Issue', value: { __typename: 'Issue', repo, issue } }, sub, variables, errors, parser));
    }
    if (field === 'totalCount') return val.totalCount as number;
    if (field === 'pageInfo') return child('PageInfo', val.pageInfo);
    return null;
  }

  if (parent.type === 'PullRequestConnection') {
    if (field === 'nodes') {
      const nodes = val.nodes as PullRequest[];
      const repo = val.repo as Repo;
      return nodes.map((pr) => executeGqlSelections({ type: 'PullRequest', value: { __typename: 'PullRequest', repo, pr } }, sub, variables, errors, parser));
    }
    if (field === 'totalCount') return val.totalCount as number;
    if (field === 'pageInfo') return child('PageInfo', val.pageInfo);
    return null;
  }

  if (parent.type === 'PullRequest') {
    const pr = val.pr as PullRequest;
    const repo = val.repo as Repo;
    switch (field) {
      case 'id': return pr.globalId;
      case 'number': return pr.number;
      case 'title': return pr.title;
      case 'body': return pr.body;
      case 'state': return prStateGql(pr);
      case 'merged': return pr.merged;
      case 'headRefName': return pr.headRef;
      case 'baseRefName': return pr.baseRef;
      case 'mergeable': return prMergeableGql(repo, pr);
      case 'mergedAt': return pr.mergedAt;
      case 'createdAt': return FIXED_ISO;
      case 'url': return `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`;
      case 'headRefOid': return pr.headSha;
      case 'baseRefOid': return pr.baseSha;
      case 'author': return child('User', { __typename: 'User', login: VIEWER_LOGIN });
      case 'files': {
        const files = prFiles(repo, pr);
        const first = typeof args.first === 'number' ? args.first : files.length;
        const pageItems = files.slice(0, first);
        return child('PullRequestChangedFileConnection', {
          __typename: 'PullRequestChangedFileConnection',
          nodes: pageItems,
          pageInfo: { hasNextPage: files.length > first, endCursor: null, hasPreviousPage: false, startCursor: null },
          totalCount: files.length,
        });
      }
      default: return null;
    }
  }

  if (parent.type === 'PullRequestChangedFileConnection') {
    if (field === 'nodes') {
      const nodes = val.nodes as Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
      return nodes.map((file) => executeGqlSelections({ type: 'PullRequestChangedFile', value: file }, sub, variables, errors, parser));
    }
    if (field === 'totalCount') return val.totalCount as number;
    if (field === 'pageInfo') return child('PageInfo', val.pageInfo);
    return null;
  }

  if (parent.type === 'PullRequestChangedFile') {
    const file = val as unknown as { filename: string; status: string; additions: number; deletions: number; changes: number };
    if (field === 'path' || field === 'filename') return file.filename;
    if (field === 'status') return file.status;
    if (field === 'additions') return file.additions;
    if (field === 'deletions') return file.deletions;
    if (field === 'changes') return file.changes;
    return null;
  }

  if (parent.type === 'Ref') {
    if (field === 'name') return String(val.name ?? '');
    if (field === 'target') return null;
    return null;
  }

  if (parent.type === 'PageInfo') {
    const info = val as Record<string, unknown>;
    if (field === 'hasNextPage') return info.hasNextPage ?? false;
    if (field === 'endCursor') return info.endCursor ?? null;
    if (field === 'hasPreviousPage') return info.hasPreviousPage ?? false;
    if (field === 'startCursor') return info.startCursor ?? null;
    return null;
  }

  if (parent.type === '__Type') {
    const typeName = String(val.typeName ?? '');
    if (field === 'name') return typeName;
    if (field === 'kind') return GQL_ENUM_VALUES[typeName] !== undefined ? 'ENUM' : 'OBJECT';
    if (field === 'description') return null;
    if (field === 'fields') {
      const fields = (val.fields as string[]).map((name) => ({ name }));
      return fields.map((f) => executeGqlSelections({ type: '__Field', value: f }, sub, variables, errors, parser));
    }
    if (field === 'enumValues') {
      const values = (val.enumValues as string[]).map((name) => ({ name }));
      return values.map((f) => executeGqlSelections({ type: '__EnumValue', value: f }, sub, variables, errors, parser));
    }
    return null;
  }

  if (parent.type === '__Field' || parent.type === '__EnumValue') {
    if (field === 'name') return String(val.name ?? '');
    if (field === 'description') return null;
    if (field === 'type') return { name: 'String', kind: 'SCALAR' };
    return null;
  }

  if (parent.type === '__Schema') {
    if (field === 'types') return [];
    if (field === 'queryType') return { name: 'Query' };
    return null;
  }

  if (parent.type === 'IssueComment') {
    if (field === 'id') return String(val.id ?? '');
    if (field === 'body') return String(val.body ?? '');
    if (field === 'author') return child('User', { __typename: 'User', login: VIEWER_LOGIN });
    return null;
  }

  // Mutation payloads: each payload field carries the object the mutation
  // produced, projected with that field's own selection set.
  if (parent.type === 'CreateIssuePayload' || parent.type === 'CloseIssuePayload') {
    if (field === 'issue') {
      const issue = val.issue as Issue | undefined;
      const repo = val.repo as Repo | undefined;
      if (!issue || !repo) return null;
      return child('Issue', { __typename: 'Issue', repo, issue });
    }
    return null;
  }

  if (parent.type === 'CreatePullRequestPayload' || parent.type === 'MergePullRequestPayload') {
    if (field === 'pullRequest') {
      const pr = val.pr as PullRequest | undefined;
      const repo = val.repo as Repo | undefined;
      if (!pr || !repo) return null;
      return child('PullRequest', { __typename: 'PullRequest', repo, pr });
    }
    return null;
  }

  if (parent.type === 'AddCommentPayload') {
    if (field === 'commentEdge') {
      const comment = val.comment as { id: string; body: string } | undefined;
      if (!comment) return null;
      return child('AddCommentEdge', { __typename: 'AddCommentEdge', comment });
    }
    return null;
  }

  if (parent.type === 'AddCommentEdge') {
    if (field === 'node') {
      const comment = val.comment as { id: string; body: string } | undefined;
      if (!comment) return null;
      return child('IssueComment', { __typename: 'IssueComment', id: comment.id, body: comment.body });
    }
    return null;
  }

  return null;
}

function executeGqlOperation(operation: GqlOperation, variables: Record<string, unknown>, parser: GqlParser): { data: unknown; errors?: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const [name, defaultValue] of Object.entries(operation.variables)) {
    if (mergedVariables[name] === undefined) mergedVariables[name] = resolveValue(defaultValue, variables);
  }
  if (operation.kind === 'mutation') {
    return executeGqlMutation(operation, mergedVariables, errors);
  }
  const data = executeGqlSelections({ type: 'Query', value: { __typename: 'Query' } }, operation.selections, mergedVariables, errors, parser);
  return errors.length > 0 ? { data, errors } : { data };
}

function findRepoByGlobalId(id: string): Repo | undefined {
  const decoded = decodeGid(id);
  if (!decoded || decoded.kind !== 'Repository') return undefined;
  return [...repos.values()].find((r) => r.dbId === Number(decoded.key));
}

function executeGqlMutation(operation: GqlOperation, variables: Record<string, unknown>, errors: Array<{ message: string }>): { data: unknown; errors?: Array<{ message: string }> } {
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    const key = selection.alias ?? selection.name;
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of Object.entries(selection.args)) args[argName] = resolveValue(argValue, variables);
    const input = (args.input ?? {}) as Record<string, unknown>;
    const sub = selection.selections ?? [];
    const projectPayload = (type: string, value: unknown): unknown =>
      executeGqlSelections({ type, value }, sub, variables, errors, new GqlParser(''));
    if (selection.name === 'createIssue') {
      const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
      if (!repo) {
        errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        data[key] = { issue: null };
        continue;
      }
      const issue = createIssueIn(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      data[key] = projectPayload('CreateIssuePayload', { __typename: 'CreateIssuePayload', repo, issue });
    } else if (selection.name === 'closeIssue') {
      const decoded = decodeGid(String(input.issueId ?? ''));
      let closed: Issue | null = null;
      let repo: Repo | undefined;
      if (decoded?.kind === 'Issue') {
        const [dbId, number] = decoded.key.split(':');
        repo = [...repos.values()].find((r) => r.dbId === Number(dbId));
        closed = repo?.issues.find((i) => i.number === Number(number)) ?? null;
      }
      if (!closed || !repo) {
        errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        data[key] = { issue: null };
        continue;
      }
      closed.state = 'closed';
      data[key] = projectPayload('CloseIssuePayload', { __typename: 'CloseIssuePayload', repo, issue: closed });
    } else if (selection.name === 'createPullRequest') {
      const repo = findRepoByGlobalId(String(input.repositoryId ?? ''));
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (!repo || !repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        errors.push({ message: 'Could not resolve to a Repository or branch for the pull request.' });
        data[key] = { pullRequest: null };
        continue;
      }
      const pr = createPullIn(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      if (!pr) {
        errors.push({ message: 'Could not create the pull request.' });
        data[key] = { pullRequest: null };
        continue;
      }
      data[key] = projectPayload('CreatePullRequestPayload', { __typename: 'CreatePullRequestPayload', repo, pr });
    } else if (selection.name === 'mergePullRequest') {
      const decoded = decodeGid(String(input.pullRequestId ?? ''));
      let pr: PullRequest | null = null;
      let repo: Repo | undefined;
      if (decoded?.kind === 'PullRequest') {
        const [dbId, number] = decoded.key.split(':');
        repo = [...repos.values()].find((r) => r.dbId === Number(dbId));
        pr = repo?.pulls.find((p) => p.number === Number(number)) ?? null;
      }
      if (!pr || !repo) {
        errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
        data[key] = { pullRequest: null };
        continue;
      }
      if (pr.state === 'open') {
        const result = squashMerge(repo, pr);
        if (result.conflict) {
          errors.push({ message: 'Merge conflict: the pull request cannot be merged.' });
          data[key] = projectPayload('MergePullRequestPayload', { __typename: 'MergePullRequestPayload', repo, pr });
          continue;
        }
      }
      data[key] = projectPayload('MergePullRequestPayload', { __typename: 'MergePullRequestPayload', repo, pr });
    } else if (selection.name === 'addComment') {
      const decoded = decodeGid(String(input.subjectId ?? ''));
      let issue: Issue | null = null;
      let repo: Repo | undefined;
      if (decoded?.kind === 'Issue') {
        const [dbId, number] = decoded.key.split(':');
        repo = [...repos.values()].find((r) => r.dbId === Number(dbId));
        issue = repo?.issues.find((i) => i.number === Number(number)) ?? null;
      }
      if (!issue || !repo) {
        errors.push({ message: 'Could not resolve to a subject with the id provided.' });
        data[key] = { commentEdge: null };
        continue;
      }
      const id = nextNumericId();
      const comment: Comment = { id, globalId: gid('IssueComment', `${repo.dbId}:${issue.number}:${id}`), body: String(input.body ?? '') };
      issue.comments.push(comment);
      data[key] = projectPayload('AddCommentPayload', {
        __typename: 'AddCommentPayload',
        comment: { id: comment.globalId, body: comment.body },
      });
    } else {
      errors.push({ message: `Cannot query field "${selection.name}" on type "Mutation".` });
      data[key] = null;
    }
  }
  return errors.length > 0 ? { data, errors } : { data };
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    errJson(res, 405, 'Method Not Allowed');
    return;
  }
  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    errJson(res, 400, 'Problems parsing JSON');
    return;
  }
  const docs = Array.isArray(parsed) ? parsed : [parsed];
  const results: Array<{ data: unknown; errors?: Array<{ message: string }> }> = [];
  for (const doc of docs) {
    const obj = asObj(doc);
    if (!obj || typeof obj.query !== 'string') {
      results.push({ data: null, errors: [{ message: 'Must provide query string.' }] });
      continue;
    }
    const variables = (asObj(obj.variables) ?? {}) as Record<string, unknown>;
    let operations: GqlOperation[];
    let parser: GqlParser;
    try {
      parser = new GqlParser(obj.query);
      operations = parser.parseDocument();
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] });
      continue;
    }
    let operation = operations[0];
    if (typeof obj.operationName === 'string') {
      operation = operations.find((op) => op.name === obj.operationName) ?? operation;
    }
    if (!operation) {
      results.push({ data: null, errors: [{ message: 'Must provide an operation.' }] });
      continue;
    }
    results.push(executeGqlOperation(operation, variables, parser));
  }
  sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
}

// ---------------------------------------------------------------- MCP

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The full repository name, owner/repo.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpSplitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = str(args.owner);
  let repo = str(args.repo);
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      if (owner === '') owner = parts[0]!;
      if (repo === '') repo = parts[1]!;
    }
  }
  return { owner, repo };
}

function mcpToolResult(id: unknown, value: unknown, isError = false): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    result: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
      isError,
    },
  };
}

function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'POST';
  if (method === 'DELETE') {
    sendJson(res, 200, {});
    return;
  }
  if (method !== 'POST') {
    errJson(res, 405, 'Method Not Allowed');
    return;
  }
  if (!authed(req)) {
    errJson(res, 401, 'Requires authentication');
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const answers: Array<Record<string, unknown>> = [];
  for (const request of requests) {
    const obj = asObj(request);
    if (!obj || typeof obj.method !== 'string') {
      answers.push(mcpError(obj?.id ?? null, -32600, 'Invalid Request'));
      continue;
    }
    const id = obj.id ?? null;
    // Notifications carry no id and get no JSON-RPC answer.
    if (id === null || id === undefined) {
      continue;
    }
    const params = asObj(obj.params) ?? {};
    switch (obj.method) {
      case 'server/discover': {
        answers.push({
          jsonrpc: '2.0',
          id,
          result: {
            supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
            capabilities: { tools: {} },
            serverInfo: { name: 'forge', version: VERSION },
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge', version: VERSION } },
          },
        });
        break;
      }
      case 'initialize': {
        const requested = str(params.protocolVersion, '2026-07-28');
        const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
        answers.push({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: supported.includes(requested) ? requested : '2026-07-28',
            capabilities: { tools: {} },
            serverInfo: { name: 'forge', version: VERSION },
          },
        });
        break;
      }
      case 'ping': {
        answers.push({ jsonrpc: '2.0', id, result: {} });
        break;
      }
      case 'tools/list': {
        answers.push({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
        break;
      }
      case 'tools/call': {
        const name = str(params.name);
        const args = (asObj(params.arguments) ?? {}) as Record<string, unknown>;
        const tool = MCP_TOOLS.find((t) => t.name.toLowerCase() === name.toLowerCase() || t.name.toLowerCase().endsWith(name.toLowerCase()));
        if (!tool) {
          answers.push(mcpError(id, -32602, `Unknown tool: ${name}`));
          break;
        }
        const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
        if (missing.length > 0) {
          answers.push(mcpError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`));
          break;
        }
        if (name === 'create_repo' || tool.name === 'create_repo') {
          const repoName = str(args.name);
          if (findRepo(VIEWER_LOGIN, repoName)) {
            answers.push(mcpToolResult(id, repoJson(findRepo(VIEWER_LOGIN, repoName)!)));
          } else {
            const repo = createRepo(repoName, args.private === true, str(args.description));
            answers.push(mcpToolResult(id, repoJson(repo)));
          }
          break;
        }
        const { owner, repo: repoName } = mcpSplitFullName(args);
        const repo = owner !== '' ? findRepo(owner, repoName) : undefined;
        if (!repo) {
          answers.push(mcpToolResult(id, { error: `Repository not found: ${owner}/${repoName}` }, true));
          break;
        }
        if (tool.name === 'get_repo') {
          answers.push(mcpToolResult(id, repoJson(repo)));
        } else if (tool.name === 'create_issue') {
          const issue = createIssueIn(repo, str(args.title), str(args.body), []);
          answers.push(mcpToolResult(id, issueJson(repo, issue)));
        } else if (tool.name === 'list_issues') {
          const state = str(args.state, 'open');
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          answers.push(mcpToolResult(id, { issues: list.map((i) => issueJson(repo, i)) }));
        } else if (tool.name === 'create_pull_request') {
          const head = str(args.head);
          const base = str(args.base);
          if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
            answers.push(mcpToolResult(id, { error: 'head or base branch does not exist' }, true));
            break;
          }
          const pr = createPullIn(repo, str(args.title), str(args.body), head, base);
          if (!pr) {
            answers.push(mcpToolResult(id, { error: 'could not create pull request' }, true));
            break;
          }
          answers.push(mcpToolResult(id, pullJson(repo, pr)));
        } else if (tool.name === 'merge_pull_request') {
          const number = Number(args.pull_number ?? args.number ?? 0);
          const pr = repo.pulls.find((p) => p.number === number);
          if (!pr) {
            answers.push(mcpToolResult(id, { error: `Pull request #${number} not found` }, true));
            break;
          }
          if (pr.state !== 'open') {
            answers.push(mcpToolResult(id, { error: 'Pull request is already closed' }, true));
            break;
          }
          const result = squashMerge(repo, pr);
          if (result.conflict) {
            answers.push(mcpToolResult(id, { error: 'Merge conflict' }, true));
            break;
          }
          answers.push(mcpToolResult(id, { sha: result.sha, merged: true, message: 'Pull request successfully merged' }));
        } else {
          answers.push(mcpError(id, -32601, `Method not found: ${name}`));
        }
        break;
      }
      default: {
        answers.push(mcpError(id, -32601, `Method not found: ${obj.method}`));
        break;
      }
    }
  }
  if (answers.length === 0) {
    res.writeHead(202, { 'content-length': '0' });
    res.end();
    return;
  }
  sendJson(res, 200, Array.isArray(parsed) ? answers : answers[0]);
}

// ---------------------------------------------------------------- server

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const segs = pathSegments(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && segs.length === 1 && segs[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (segs.length >= 2 && segs[0] === 'api' && segs[1] === 'v3') {
          await handleRest(req, res, segs);
          return;
        }
        if (segs.length === 2 && segs[0] === 'api' && segs[1] === 'graphql') {
          await handleGraphQL(req, res);
          return;
        }
        if (segs.length === 1 && segs[0] === 'mcp') {
          await handleMcp(req, res);
          return;
        }
        if (await handleGit(req, res, segs)) return;
        errJson(res, 404, 'Not Found');
      } catch (err) {
        try {
          errJson(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });
}
