import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  listChats,
  deleteChats,
  listTrash,
  restoreChats,
  emptyTrash,
  encodeProject,
} from '../scripts/claude-chat-cleaner.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/claude-chat-cleaner.mjs', import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';
const D = 'dddddddd-4444-4444-8444-444444444444';
const A2 = 'aaaaaaaa-9999-4999-8999-999999999999'; // shares the "aaaaaaaa" prefix with A

const CWD = '/tmp/proj';
const OTHER_CWD = '/tmp/other';

const line = (o) => JSON.stringify(o) + '\n';
const user = (sessionId, content, extra = {}) =>
  line({ type: 'user', sessionId, cwd: extra.cwd ?? CWD, message: { role: 'user', content }, ...extra });
const assistant = (sessionId) =>
  line({ type: 'assistant', sessionId, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function setMtime(file, ms) {
  const t = new Date(ms);
  fs.utimesSync(file, t, t);
}

// Builds a fake ~/.claude with four chats in two projects.
function makeConfig({ now = Date.now() } = {}) {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-chat-cleaner-test-'));
  const proj = path.join(config, 'projects', encodeProject(CWD));
  const other = path.join(config, 'projects', encodeProject(OTHER_CWD));

  // A: titled chat with subagent data, file-history and session-env.
  write(
    path.join(proj, `${A}.jsonl`),
    user(A, '<local-command-caveat>Caveat: ignore</local-command-caveat>') +
      user(A, 'first question') +
      assistant(A) +
      line({ type: 'ai-title', aiTitle: 'Old title', sessionId: A }) +
      user(A, [{ type: 'text', text: 'second question' }]) +
      user(A, [{ type: 'tool_result', tool_use_id: 'x', content: 'tool output' }]) +
      assistant(A) +
      line({ type: 'ai-title', aiTitle: 'Alpha title', sessionId: A }),
  );
  write(path.join(proj, A, 'subagents', 'agent-1.jsonl'), line({ type: 'user' }));
  write(path.join(proj, A, 'tool-results', 'r.txt'), 'result');
  write(path.join(config, 'file-history', A, 'snap@v1'), 'snapshot');
  write(path.join(config, 'session-env', A, 'env'), 'env');

  // B: no title, falls back to the first real prompt.
  write(
    path.join(proj, `${B}.jsonl`),
    user(B, '<local-command-caveat>Caveat</local-command-caveat>') +
      user(B, 'fix the login bug please') +
      assistant(B),
  );

  // C: bridge-only chat with no messages.
  write(
    path.join(proj, `${C}.jsonl`),
    line({ type: 'bridge-session', sessionId: C, bridgeSessionId: 'cse_x' }),
  );

  // D: another project, renamed by the user.
  write(
    path.join(other, `${D}.jsonl`),
    user(D, 'other project prompt', { cwd: OTHER_CWD }) +
      line({ type: 'ai-title', aiTitle: 'AI name', sessionId: D }) +
      line({ type: 'custom-title', customTitle: 'My renamed chat', sessionId: D }),
  );

  setMtime(path.join(proj, `${A}.jsonl`), now - 1 * DAY);
  setMtime(path.join(proj, `${B}.jsonl`), now - 2 * DAY);
  setMtime(path.join(proj, `${C}.jsonl`), now - 3 * DAY);
  setMtime(path.join(other, `${D}.jsonl`), now - 4 * DAY);

  write(
    path.join(config, 'history.jsonl'),
    line({ display: 'first question', timestamp: 1000, project: CWD, sessionId: A }) +
      line({ display: 'fix the login bug please', timestamp: 2000, project: CWD, sessionId: B }) +
      line({ display: 'second question', timestamp: 3000, project: CWD, sessionId: A }) +
      line({ display: 'other project prompt', timestamp: 4000, project: OTHER_CWD, sessionId: D }),
  );

  return { config, proj, other, now };
}

// Snapshot of every file under the config dir, for "nothing changed" checks.
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const historyIds = (config) =>
  fs
    .readFileSync(path.join(config, 'history.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).sessionId);

test('encodeProject replaces every non-alphanumeric character with a dash', () => {
  assert.equal(encodeProject('/Users/krishiv/Downloads/Findit'), '-Users-krishiv-Downloads-Findit');
  assert.equal(encodeProject('/a/b.c_d e'), '-a-b-c-d-e');
  assert.equal(encodeProject('C:\\Users\\me'), 'C--Users-me');
});

test('list shows the current project newest first with titles, prompts and empty flag', async () => {
  const { config, now } = makeConfig();
  const res = await listChats({ config, now, cwd: CWD, current: D });
  assert.deepEqual(res.chats.map((c) => c.id), [A, B, C]);
  assert.deepEqual(res.chats.map((c) => c.index), [1, 2, 3]);

  const [a, b, c] = res.chats;
  assert.equal(a.title, 'Alpha title');
  assert.equal(a.prompts, 2);
  assert.equal(a.empty, false);
  assert.equal(a.project, CWD);
  assert.equal(b.title, 'fix the login bug please');
  assert.equal(b.prompts, 1);
  assert.equal(c.empty, true);
  assert.equal(c.prompts, 0);
  assert.equal(c.project, CWD, 'empty chats borrow the project path from their siblings');
  assert.ok(res.chats.every((x) => !x.current));
});

test('list --all includes every project and prefers a custom title', async () => {
  const { config, now } = makeConfig();
  const res = await listChats({ config, now, cwd: CWD, all: true, current: C });
  assert.deepEqual(res.chats.map((c) => c.id), [A, B, C, D]);
  assert.equal(res.chats[3].title, 'My renamed chat');
  assert.equal(res.chats[3].project, OTHER_CWD);
  assert.equal(res.chats[2].current, true);
});

test('list finds a project folder through the cwd field when the encoded name does not match', async () => {
  const { config, proj, now } = makeConfig();
  fs.renameSync(proj, path.join(config, 'projects', 'renamed-folder'));
  const res = await listChats({ config, now, cwd: CWD, current: D });
  assert.deepEqual(res.chats.map((c) => c.id), [A, B, C]);
});

test('list returns nothing for a project with no chats', async () => {
  const { config, now } = makeConfig();
  const res = await listChats({ config, now, cwd: '/nowhere', current: A });
  assert.deepEqual(res.chats, []);
});

test('without a known current session, the newest chat in the project is protected', async () => {
  const { config, now } = makeConfig();
  const res = await listChats({ config, now, cwd: CWD });
  assert.equal(res.current, A);
  assert.equal(res.chats[0].current, true);
  await assert.rejects(deleteChats([A], { config, now, cwd: CWD }), /current chat/);
});

test('delete moves every file for the chat into the trash and removes its history lines', async () => {
  const { config, proj, now } = makeConfig();
  const res = await deleteChats([A], { config, now, cwd: CWD, current: D });
  assert.deepEqual(res.deleted.map((d) => d.id), [A]);
  assert.equal(res.deleted[0].title, 'Alpha title');

  for (const p of [
    path.join(proj, `${A}.jsonl`),
    path.join(proj, A),
    path.join(config, 'file-history', A),
    path.join(config, 'session-env', A),
  ]) {
    assert.equal(fs.existsSync(p), false, `${p} should be gone`);
  }
  assert.deepEqual(historyIds(config), [B, D]);

  const entry = path.join(config, 'chat-trash', A);
  const manifest = JSON.parse(fs.readFileSync(path.join(entry, 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, A);
  assert.equal(manifest.items.length, 4);
  assert.equal(manifest.historyLines, 2);
  assert.equal(fs.readFileSync(path.join(entry, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2);

  const after = await listChats({ config, now, cwd: CWD, current: D });
  assert.deepEqual(after.chats.map((c) => c.id), [B, C]);
});

test('delete then restore puts everything back exactly', async () => {
  const { config, now } = makeConfig();
  const before = snapshot(config);
  await deleteChats([A, C], { config, now, cwd: CWD, current: D });
  assert.equal((await listTrash({ config, now })).trash.length, 2);

  const res = await restoreChats([A, C], { config, now });
  assert.deepEqual(res.restored.map((r) => r.id).sort(), [A, C]);
  assert.deepEqual(snapshot(config), before);
  assert.equal(fs.existsSync(path.join(config, 'chat-trash', A)), false);
});

test('delete refuses the current chat and changes nothing', async () => {
  const { config, now } = makeConfig();
  const before = snapshot(config);
  await assert.rejects(deleteChats([B, A], { config, now, cwd: CWD, current: A }), /current chat/);
  assert.deepEqual(snapshot(config), before);
});

test('delete accepts a unique id prefix and rejects an ambiguous or unknown one', async () => {
  const { config, proj, now } = makeConfig();
  const res = await deleteChats(['bbbb'], { config, now, cwd: CWD, current: D });
  assert.deepEqual(res.deleted.map((d) => d.id), [B]);

  write(path.join(proj, `${A2}.jsonl`), user(A2, 'hello'));
  const before = snapshot(config);
  await assert.rejects(deleteChats(['aaaaaaaa'], { config, now, cwd: CWD, current: D }), /matches more than one/);
  await assert.rejects(deleteChats(['ffffffff'], { config, now, cwd: CWD, current: D }), /No chat found/);
  await assert.rejects(deleteChats(['../etc'], { config, now, cwd: CWD, current: D }), /Not a chat id/);
  assert.deepEqual(snapshot(config), before);
});

test('delete works on a chat in another project', async () => {
  const { config, other, now } = makeConfig();
  await deleteChats([D], { config, now, cwd: CWD, current: A });
  assert.equal(fs.existsSync(path.join(other, `${D}.jsonl`)), false);
  assert.deepEqual(historyIds(config), [A, B, A]);
});

test('restore refuses when a file is already back in place', async () => {
  const { config, proj, now } = makeConfig();
  await deleteChats([B], { config, now, cwd: CWD, current: D });
  write(path.join(proj, `${B}.jsonl`), 'new content');
  await assert.rejects(restoreChats([B], { config, now }), /already exists/);
  assert.equal((await listTrash({ config, now })).trash.length, 1);
});

test('restore merges history lines back in timestamp order', async () => {
  const { config, now } = makeConfig();
  await deleteChats([A], { config, now, cwd: CWD, current: D });
  fs.appendFileSync(
    path.join(config, 'history.jsonl'),
    line({ display: 'newer', timestamp: 5000, project: CWD, sessionId: B }),
  );
  await restoreChats([A], { config, now });
  const ts = fs
    .readFileSync(path.join(config, 'history.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).timestamp);
  assert.deepEqual(ts, [1000, 2000, 3000, 4000, 5000]);
});

test('trash shows days left and old entries are purged automatically', async () => {
  const { config, now } = makeConfig();
  await deleteChats([B], { config, now: now - 31 * DAY, cwd: CWD, current: D });
  await deleteChats([C], { config, now: now - 10 * DAY, cwd: CWD, current: D });

  const res = await listTrash({ config, now, trashDays: 30 });
  assert.deepEqual(res.trash.map((t) => t.id), [C]);
  assert.equal(res.trash[0].daysLeft, 20);
  assert.deepEqual(res.purged, [B]);
  assert.equal(fs.existsSync(path.join(config, 'chat-trash', B)), false);
});

test('trashDays 0 turns automatic purging off', async () => {
  const { config, now } = makeConfig();
  await deleteChats([B], { config, now: now - 400 * DAY, cwd: CWD, current: D });
  const res = await listTrash({ config, now, trashDays: 0 });
  assert.deepEqual(res.trash.map((t) => t.id), [B]);
  assert.equal(res.trash[0].daysLeft, null);
});

test('empty-trash removes everything, or only entries older than a given age', async () => {
  const { config, now } = makeConfig();
  await deleteChats([B], { config, now: now - 5 * DAY, cwd: CWD, current: D });
  await deleteChats([C], { config, now: now - 1 * DAY, cwd: CWD, current: D });

  const partial = await emptyTrash({ config, now, olderThan: 3 });
  assert.deepEqual(partial.removed, [B]);
  assert.deepEqual((await listTrash({ config, now })).trash.map((t) => t.id), [C]);

  const all = await emptyTrash({ config, now });
  assert.deepEqual(all.removed, [C]);
  assert.deepEqual(fs.readdirSync(path.join(config, 'chat-trash')), []);
});

test('restore ignores a tampered manifest that points outside the config dir', async () => {
  const { config, now } = makeConfig();
  await deleteChats([B], { config, now, cwd: CWD, current: D });
  const mf = path.join(config, 'chat-trash', B, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  manifest.items[0].original = '../../evil.jsonl';
  fs.writeFileSync(mf, JSON.stringify(manifest));
  await assert.rejects(restoreChats([B], { config, now }), /Unsafe path/);
});

test('CLI honours CLAUDE_CONFIG_DIR and prints JSON', () => {
  const { config } = makeConfig();
  const run = (...args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '' },
      encoding: 'utf8',
    });

  const list = run('list', '--cwd', CWD, '--current', D, '--json');
  assert.equal(list.status, 0, list.stderr);
  const parsed = JSON.parse(list.stdout);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.chats.map((c) => c.id), [A, B, C]);

  const table = run('list', '--cwd', CWD, '--current', D);
  assert.match(table.stdout, /Alpha title/);

  const del = run('delete', A, '--cwd', CWD, '--current', A, '--json');
  assert.equal(del.status, 1);
  assert.equal(JSON.parse(del.stdout).ok, false);

  const unsubstituted = run('list', '--cwd', CWD, '--current', '${CLAUDE_SESSION_ID}', '--json');
  assert.equal(JSON.parse(unsubstituted.stdout).current, A);

  const fromEnv = spawnSync(process.execPath, [SCRIPT, 'list', '--cwd', CWD, '--json'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: C },
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(fromEnv.stdout).current, C);
});
