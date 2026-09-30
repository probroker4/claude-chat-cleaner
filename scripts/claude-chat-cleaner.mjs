#!/usr/bin/env node
// List, delete (to a trash folder) and restore Claude Code chats.
// No dependencies. Node 18+. Run with no arguments for help.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const DAY = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_RE = /^[0-9a-f-]{4,36}$/i;
const TITLE_MAX = 60;
const RECENT_MS = 5 * 60 * 1000;
const TRASH = 'chat-trash';
const STORED_NAMES = new Set(['transcript.jsonl', 'transcript-data', 'file-history', 'session-env']);

// ---------- paths ----------

export function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function encodeProject(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function defaultTrashDays() {
  const raw = process.env.CLAUDE_CHAT_CLEANER_TRASH_DAYS;
  if (raw === undefined || raw === '') return 30;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

function ctxFrom(opts = {}) {
  return {
    config: opts.config ?? configDir(),
    now: opts.now ?? Date.now(),
    cwd: opts.cwd ?? process.cwd(),
    trashDays: opts.trashDays ?? defaultTrashDays(),
    current: UUID_RE.test(opts.current ?? '') ? opts.current.toLowerCase() : null,
  };
}

const projectsRoot = (ctx) => path.join(ctx.config, 'projects');
const trashRoot = (ctx) => path.join(ctx.config, TRASH);

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function chatFilesIn(projectDir) {
  return readDirSafe(projectDir)
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl') && UUID_RE.test(e.name.slice(0, -6)))
    .map((e) => ({ id: e.name.slice(0, -6).toLowerCase(), file: path.join(projectDir, e.name), projectDir }));
}

function allChatFiles(ctx) {
  return readDirSafe(projectsRoot(ctx))
    .filter((e) => e.isDirectory())
    .flatMap((e) => chatFilesIn(path.join(projectsRoot(ctx), e.name)));
}

// Reads the start of a transcript and returns its "cwd" field, if any.
function cwdOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const l of buf.toString('utf8', 0, n).split('\n')) {
      if (!l.includes('"cwd"')) continue;
      try {
        const cwd = JSON.parse(l).cwd;
        if (typeof cwd === 'string') return cwd;
      } catch {
        // partial line at the end of the buffer
      }
    }
  } catch {
    // unreadable file
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

// The folder Claude Code uses for a working directory. Falls back to
// matching the "cwd" recorded inside transcripts if the encoding differs.
function findProjectDir(ctx, cwd) {
  const encoded = path.join(projectsRoot(ctx), encodeProject(cwd));
  if (fs.existsSync(encoded)) return encoded;
  for (const e of readDirSafe(projectsRoot(ctx))) {
    if (!e.isDirectory()) continue;
    const dir = path.join(projectsRoot(ctx), e.name);
    const files = chatFilesIn(dir).slice(0, 5);
    if (files.some((f) => cwdOf(f.file) === cwd)) return dir;
  }
  return null;
}

// The working directory a project folder belongs to, from any of its transcripts.
const projectCwdCache = new Map();
function projectCwd(projectDir) {
  if (!projectCwdCache.has(projectDir)) {
    let cwd = null;
    for (const f of chatFilesIn(projectDir)) if ((cwd = cwdOf(f.file))) break;
    projectCwdCache.set(projectDir, cwd);
  }
  return projectCwdCache.get(projectDir);
}

// The chat to protect: the given id, or else the newest chat in this project.
function resolveCurrent(ctx) {
  if (ctx.current) return ctx.current;
  const dir = findProjectDir(ctx, ctx.cwd);
  if (!dir) return null;
  let newest = null;
  for (const f of chatFilesIn(dir)) {
    const m = fs.statSync(f.file).mtimeMs;
    if (!newest || m > newest.m) newest = { id: f.id, m };
  }
  return newest?.id ?? null;
}

// ---------- reading a transcript ----------

function promptText(rec) {
  if (rec?.type !== 'user' || rec.isMeta || rec.isSidechain) return null;
  const c = rec.message?.content;
  let text;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) text = c.find((b) => b?.type === 'text')?.text;
  if (typeof text !== 'string') return null;
  if (/^\s*<local-command-(caveat|stdout|stderr)>/.test(text)) return null;
  if (/^\s*\[Request interrupted/.test(text)) return null;
  const name = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (name) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    text = `${name[1].trim()} ${args?.[1] ?? ''}`;
  }
  text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

function truncate(s, n = TITLE_MAX) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

async function readChat(file) {
  let customTitle = null;
  let aiTitle = null;
  let summary = null;
  let firstPrompt = null;
  let cwd = null;
  let prompts = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const l of rl) {
    // Only parse the lines that can matter; transcripts can be tens of MB.
    if (!(l.includes('"type":"user"') || l.includes('Title"') || l.includes('"type":"summary"'))) continue;
    let rec;
    try {
      rec = JSON.parse(l);
    } catch {
      continue;
    }
    if (rec.type === 'custom-title' && rec.customTitle) customTitle = rec.customTitle;
    else if (rec.type === 'ai-title' && rec.aiTitle) aiTitle = rec.aiTitle;
    else if (rec.type === 'summary' && rec.summary) summary = rec.summary;
    else if (rec.type === 'user') {
      if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
      const t = promptText(rec);
      if (t) {
        prompts++;
        firstPrompt ??= t;
      }
    }
  }
  const title = customTitle || aiTitle || summary || firstPrompt || '(no messages)';
  return { title: truncate(String(title).replace(/\s+/g, ' ').trim()), cwd, prompts };
}

async function describe(ctx, f, current) {
  const st = fs.statSync(f.file);
  const info = await readChat(f.file);
  return {
    id: f.id,
    shortId: f.id.slice(0, 8),
    title: info.title,
    project: info.cwd ?? projectCwd(f.projectDir) ?? path.basename(f.projectDir),
    lastActive: new Date(st.mtimeMs).toISOString(),
    lastActiveAgo: ago(ctx.now - st.mtimeMs),
    sizeBytes: st.size,
    size: humanSize(st.size),
    prompts: info.prompts,
    empty: info.prompts === 0,
    current: f.id === current,
    recentlyActive: ctx.now - st.mtimeMs < RECENT_MS,
  };
}

// ---------- trash ----------

function readManifest(entryDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(entryDir, 'manifest.json'), 'utf8'));
    return m && UUID_RE.test(m.id) ? m : null;
  } catch {
    return null;
  }
}

function trashEntries(ctx) {
  return readDirSafe(trashRoot(ctx))
    .filter((e) => e.isDirectory() && UUID_RE.test(e.name))
    .map((e) => {
      const dir = path.join(trashRoot(ctx), e.name);
      return { dir, manifest: readManifest(dir) };
    })
    .filter((e) => e.manifest && e.manifest.id === path.basename(e.dir));
}

const ageDays = (ctx, m) => (ctx.now - Date.parse(m.deletedAt)) / DAY;

function purgeExpired(ctx) {
  if (!(ctx.trashDays > 0)) return [];
  const purged = [];
  for (const e of trashEntries(ctx)) {
    if (ageDays(ctx, e.manifest) >= ctx.trashDays) {
      fs.rmSync(e.dir, { recursive: true, force: true });
      purged.push(e.manifest.id);
    }
  }
  return purged;
}

// Turns a manifest path back into an absolute path, refusing anything
// that would land outside the config dir or isn't about this chat.
function safeOriginal(ctx, rel, id) {
  const parts = typeof rel === 'string' ? rel.split('/') : [];
  const root = path.resolve(ctx.config);
  const full = path.resolve(root, ...parts);
  if (
    !parts.length ||
    path.isAbsolute(rel) ||
    parts.includes('..') ||
    !rel.includes(id) ||
    !full.startsWith(root + path.sep)
  ) {
    throw new Error(`Unsafe path in trash manifest for ${id}: ${rel}`);
  }
  return full;
}

// ---------- file helpers ----------

function move(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

function writeAtomic(file, content) {
  const tmp = `${file}.claude-chat-cleaner-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const splitLines = (s) => s.split('\n').filter((l) => l.trim() !== '');
const joinLines = (lines) => (lines.length ? lines.join('\n') + '\n' : '');

function readHistory(ctx) {
  try {
    return splitLines(fs.readFileSync(path.join(ctx.config, 'history.jsonl'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function sessionOf(l) {
  try {
    return String(JSON.parse(l).sessionId ?? '').toLowerCase();
  } catch {
    return '';
  }
}

function timestampOf(l) {
  try {
    const t = JSON.parse(l).timestamp;
    return typeof t === 'number' ? t : Date.parse(t) || 0;
  } catch {
    return 0;
  }
}

// ---------- commands ----------

export async function listChats(opts = {}) {
  const ctx = ctxFrom(opts);
  const purged = purgeExpired(ctx);
  const current = resolveCurrent(ctx);
  let files;
  if (opts.all) files = allChatFiles(ctx);
  else {
    const dir = findProjectDir(ctx, ctx.cwd);
    files = dir ? chatFilesIn(dir) : [];
  }
  const chats = await Promise.all(files.map((f) => describe(ctx, f, current)));
  chats.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
  chats.forEach((c, i) => (c.index = i + 1));
  return { scope: opts.all ? 'all' : 'project', cwd: ctx.cwd, current, chats, purged };
}

function resolveIds(args, candidates, what) {
  const errors = [];
  const out = [];
  for (const raw of args) {
    const q = String(raw).trim().toLowerCase();
    if (!PREFIX_RE.test(q)) {
      errors.push(`Not a chat id: "${raw}"`);
      continue;
    }
    const hits = candidates.filter((c) => c.id.startsWith(q));
    if (hits.length === 0) errors.push(`No ${what} found for "${raw}"`);
    else if (hits.length > 1) errors.push(`"${raw}" matches more than one ${what}; use more characters`);
    else if (!out.includes(hits[0])) out.push(hits[0]);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  if (!out.length) throw new Error('No chat ids given');
  return out;
}

export async function deleteChats(ids, opts = {}) {
  const ctx = ctxFrom(opts);
  const purged = purgeExpired(ctx);
  const targets = resolveIds(ids, allChatFiles(ctx), 'chat');

  const current = resolveCurrent(ctx);
  const cur = targets.find((t) => t.id === current);
  if (cur) throw new Error(`Refusing to delete the current chat (${cur.id.slice(0, 8)}). Start a new chat first.`);
  for (const t of targets) {
    if (fs.existsSync(path.join(trashRoot(ctx), t.id))) {
      throw new Error(`${t.id.slice(0, 8)} is already in the trash; restore or empty it first`);
    }
  }

  const deleted = [];
  const deletedAt = new Date(ctx.now).toISOString();
  for (const t of targets) {
    const info = await describe(ctx, t, current);
    const projectRel = path.basename(t.projectDir);
    const candidates = [
      [`projects/${projectRel}/${t.id}.jsonl`, 'transcript.jsonl'],
      [`projects/${projectRel}/${t.id}`, 'transcript-data'],
      [`file-history/${t.id}`, 'file-history'],
      [`session-env/${t.id}`, 'session-env'],
    ];
    const items = candidates
      .filter(([rel]) => fs.existsSync(path.join(ctx.config, ...rel.split('/'))))
      .map(([original, stored]) => ({ original, stored }));

    const entry = path.join(trashRoot(ctx), t.id);
    fs.mkdirSync(entry, { recursive: true });
    const manifest = {
      version: 1,
      id: t.id,
      title: info.title,
      project: info.project,
      lastActive: info.lastActive,
      deletedAt,
      items,
      historyLines: 0,
    };
    // Written before moving anything, so a crash part-way can still be restored.
    fs.writeFileSync(path.join(entry, 'manifest.json'), JSON.stringify(manifest, null, 2));
    for (const it of items) move(path.join(ctx.config, ...it.original.split('/')), path.join(entry, it.stored));
    deleted.push({ ...info, entry, manifest });
  }

  const history = readHistory(ctx);
  if (history) {
    const idSet = new Set(targets.map((t) => t.id));
    const keep = [];
    const removed = new Map();
    for (const l of history) {
      const sid = [...idSet].some((id) => l.includes(id)) ? sessionOf(l) : '';
      if (idSet.has(sid)) removed.set(sid, [...(removed.get(sid) ?? []), l]);
      else keep.push(l);
    }
    // Save the removed lines in the trash before rewriting history.jsonl.
    for (const d of deleted) {
      const lines = removed.get(d.id) ?? [];
      d.manifest.historyLines = lines.length;
      if (lines.length) fs.writeFileSync(path.join(d.entry, 'history.jsonl'), joinLines(lines));
      fs.writeFileSync(path.join(d.entry, 'manifest.json'), JSON.stringify(d.manifest, null, 2));
    }
    if (removed.size) writeAtomic(path.join(ctx.config, 'history.jsonl'), joinLines(keep));
  }

  return {
    deleted: deleted.map(({ entry, manifest, ...info }) => ({ ...info, trashPath: entry })),
    trashDays: ctx.trashDays,
    purged,
  };
}

export async function listTrash(opts = {}) {
  const ctx = ctxFrom(opts);
  const purged = purgeExpired(ctx);
  const trash = trashEntries(ctx)
    .map(({ manifest: m }) => ({
      id: m.id,
      shortId: m.id.slice(0, 8),
      title: m.title,
      project: m.project,
      deletedAt: m.deletedAt,
      deletedAgo: ago(ctx.now - Date.parse(m.deletedAt)),
      daysLeft: ctx.trashDays > 0 ? Math.max(0, Math.ceil(ctx.trashDays - ageDays(ctx, m))) : null,
    }))
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  trash.forEach((t, i) => (t.index = i + 1));
  return { trashDir: trashRoot(ctx), trashDays: ctx.trashDays, trash, purged };
}

export async function restoreChats(ids, opts = {}) {
  const ctx = ctxFrom(opts);
  const purged = purgeExpired(ctx);
  const entries = trashEntries(ctx).map((e) => ({ ...e, id: e.manifest.id }));
  const targets = resolveIds(ids, entries, 'chat in the trash');

  // Check everything before moving anything.
  const plans = targets.map((t) => {
    const moves = (t.manifest.items ?? []).map((it) => {
      if (!STORED_NAMES.has(it.stored)) throw new Error(`Unsafe path in trash manifest for ${t.id}: ${it.stored}`);
      return { from: path.join(t.dir, it.stored), to: safeOriginal(ctx, it.original, t.id) };
    });
    return { t, moves: moves.filter((m) => fs.existsSync(m.from)) };
  });
  for (const { moves } of plans) {
    for (const m of moves) {
      if (fs.existsSync(m.to)) throw new Error(`Can't restore: ${m.to} already exists`);
    }
  }

  const restoredHistory = [];
  const restored = [];
  for (const { t, moves } of plans) {
    for (const m of moves) move(m.from, m.to);
    const hist = path.join(t.dir, 'history.jsonl');
    if (fs.existsSync(hist)) restoredHistory.push(...splitLines(fs.readFileSync(hist, 'utf8')));
    restored.push({ id: t.id, shortId: t.id.slice(0, 8), title: t.manifest.title, project: t.manifest.project });
  }

  if (restoredHistory.length) {
    const merged = [...(readHistory(ctx) ?? []), ...restoredHistory]
      .map((l, i) => ({ l, i, ts: timestampOf(l) }))
      .sort((a, b) => a.ts - b.ts || a.i - b.i)
      .map((x) => x.l);
    writeAtomic(path.join(ctx.config, 'history.jsonl'), joinLines(merged));
  }
  for (const { t } of plans) fs.rmSync(t.dir, { recursive: true, force: true });

  return { restored, purged };
}

export async function emptyTrash(opts = {}) {
  const ctx = ctxFrom(opts);
  const purged = purgeExpired(ctx);
  let entries = trashEntries(ctx);
  if (opts.ids?.length) {
    entries = resolveIds(opts.ids, entries.map((e) => ({ ...e, id: e.manifest.id })), 'chat in the trash');
  }
  if (opts.olderThan !== undefined) entries = entries.filter((e) => ageDays(ctx, e.manifest) >= opts.olderThan);
  for (const e of entries) fs.rmSync(e.dir, { recursive: true, force: true });
  return { removed: entries.map((e) => e.manifest.id), purged };
}

// ---------- formatting ----------

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const units = [
    ['year', 365 * 86400],
    ['month', 30 * 86400],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [name, size] of units) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

function humanSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function table(rows, cols) {
  const widths = cols.map(([h, k]) => Math.max(h.length, ...rows.map((r) => String(r[k] ?? '').length)));
  const fmt = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join('  ').trimEnd();
  return [fmt(cols.map(([h]) => h)), ...rows.map((r) => fmt(cols.map(([, k]) => r[k] ?? '')))].join('\n');
}

function printText(command, res) {
  const lines = [];
  if (command === 'list') {
    if (!res.chats.length) lines.push(res.scope === 'all' ? 'No chats found.' : `No chats found for ${res.cwd}.`);
    else {
      const rows = res.chats.map((c) => ({ ...c, mark: c.current ? '(this chat)' : c.empty ? '(empty)' : '' }));
      const cols = [['#', 'index'], ['ID', 'shortId'], ['LAST ACTIVE', 'lastActiveAgo'], ['SIZE', 'size'], ['PROMPTS', 'prompts']];
      if (res.scope === 'all') cols.push(['PROJECT', 'project']);
      cols.push(['TITLE', 'title'], ['', 'mark']);
      lines.push(table(rows, cols));
    }
  } else if (command === 'delete') {
    for (const d of res.deleted) lines.push(`Moved to trash: ${d.shortId}  ${d.title}`);
    lines.push(
      res.trashDays > 0
        ? `Restore within ${res.trashDays} days with: claude-chat-cleaner.mjs restore <id>`
        : 'Restore any time with: claude-chat-cleaner.mjs restore <id>',
    );
  } else if (command === 'trash') {
    if (!res.trash.length) lines.push('The trash is empty.');
    else {
      const cols = [['#', 'index'], ['ID', 'shortId'], ['DELETED', 'deletedAgo'], ['DAYS LEFT', 'daysLeft'], ['TITLE', 'title']];
      lines.push(table(res.trash, cols));
    }
  } else if (command === 'restore') {
    for (const r of res.restored) lines.push(`Restored: ${r.shortId}  ${r.title}`);
  } else if (command === 'empty-trash') {
    lines.push(res.removed.length ? `Permanently deleted ${res.removed.length} chat(s).` : 'Nothing to remove.');
  }
  if (res.purged?.length) lines.push(`(Removed ${res.purged.length} chat(s) that were in the trash too long.)`);
  console.log(lines.join('\n'));
}

const HELP = `Usage: claude-chat-cleaner.mjs <command> [options]

Commands:
  list [--all]                 List chats for this folder (or every folder)
  delete <id>...               Move chats to the trash (ids or unique prefixes)
  trash                        List chats in the trash
  restore <id>...              Put chats back from the trash
  empty-trash [<id>...]        Permanently delete chats in the trash
              [--older-than N] ...only those deleted N or more days ago

Options:
  --json            Print JSON
  --cwd <dir>       Folder whose chats to list (default: current directory)
  --current <id>    The chat to protect from deletion
                    (default: $CLAUDE_CODE_SESSION_ID, else the newest chat here)

Environment:
  CLAUDE_CONFIG_DIR   Claude Code config folder (default: ~/.claude)
  CLAUDE_CHAT_CLEANER_TRASH_DAYS    Days to keep deleted chats (default 30, 0 = forever)`;

function parseArgs(argv) {
  const out = { _: [], json: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--all') out.all = true;
    else if (a === '--cwd' || a === '--current' || a === '--older-than') {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      out[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else out._.push(a);
  }
  return out;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  const [command, ...rest] = args._;
  if (!command || args.help || command === 'help') {
    console.log(HELP);
    return command || args.help ? 0 : 1;
  }

  const opts = {
    cwd: args.cwd && !path.isAbsolute(args.cwd) ? path.resolve(args.cwd) : args.cwd,
    current: [args.current, process.env.CLAUDE_CODE_SESSION_ID, process.env.CLAUDE_SESSION_ID].find((v) =>
      UUID_RE.test(v ?? ''),
    ),
  };
  try {
    let res;
    if (command === 'list') res = await listChats({ ...opts, all: args.all });
    else if (command === 'delete') res = await deleteChats(rest, opts);
    else if (command === 'trash') res = await listTrash(opts);
    else if (command === 'restore') res = await restoreChats(rest, opts);
    else if (command === 'empty-trash') {
      let olderThan;
      if (args.olderThan !== undefined) {
        olderThan = Number(args.olderThan);
        if (!Number.isFinite(olderThan) || olderThan < 0) throw new Error('--older-than must be a number of days');
      }
      res = await emptyTrash({ ...opts, ids: rest, olderThan });
    } else throw new Error(`Unknown command "${command}". Run with --help.`);

    if (args.json) console.log(JSON.stringify({ ok: true, command, ...res }, null, 2));
    else printText(command, res);
    return 0;
  } catch (e) {
    if (args.json) console.log(JSON.stringify({ ok: false, command, error: e.message }, null, 2));
    else console.error(`Error: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
