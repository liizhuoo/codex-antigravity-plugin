// Offline tests: real MCP server against fake `codex app-server` + worktree/env unit tests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildChildEnv, resolveCodexBin } from '../lib/app-server.mjs';

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
let client;

before(async () => {
  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path('../server.mjs')],
      env: {
        ...process.env,
        CODEX_BIN: path('./fake-codex.mjs'),
        CODEX_SANDBOX: 'workspace-write',
        CODEX_APPROVAL: 'on-request',
        CODEX_WAIT_SECONDS: '5',
      },
      stderr: 'ignore',
    }),
  );
});
after(() => client.close());

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}

test('exposes every expected MCP tool', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'codex_compact',
    'codex_interrupt',
    'codex_models',
    'codex_respond',
    'codex_review',
    'codex_run',
    'codex_status',
    'codex_steer',
    'codex_threads',
    'codex_wait',
    'codex_worktree',
  ]);
});

test('run → completed, then continue the same thread', async () => {
  const r = await call('codex_run', { cwd: '/tmp', prompt: 'echo hello', wait_seconds: 5 });
  assert.equal(r.status, 'completed');
  assert.equal(r.latest_message, 'hello');
  const r2 = await call('codex_run', { thread_id: r.thread_id, prompt: 'echo again', wait_seconds: 5 });
  assert.equal(r2.thread_id, r.thread_id);
  assert.equal(r2.latest_message, 'again');
  assert.deepEqual(r2.earlier_messages, []);
});

test('captures turn/diff/updated and token_usage even for shell-based edits', async () => {
  const r = await call('codex_run', { cwd: '/tmp', prompt: 'shell-edit', wait_seconds: 5 });
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.files_changed, [{ path: 'src/app.js', type: 'modified' }]);
  assert.match(r.diff_preview, /\+new/);
  assert.deepEqual(r.token_usage, { input: 100, cached: 20, output: 30 });
});

test('forwards localImage paths via images option', async () => {
  const r = await call('codex_run', {
    cwd: '/tmp',
    prompt: 'check-image',
    images: ['/tmp/a.png', '/tmp/b.png'],
    wait_seconds: 5,
  });
  assert.equal(r.latest_message, 'images=/tmp/a.png,/tmp/b.png');
});

test('approval request surfaces as pending and codex_respond unblocks it', async () => {
  const r = await call('codex_run', { cwd: '/tmp', prompt: 'approve', wait_seconds: 5 });
  assert.equal(r.status, 'waitingForInput');
  assert.equal(r.pending_requests[0].type, 'approve_command');
  assert.equal(r.pending_requests[0].command, 'rm -rf build');
  const done = await call('codex_respond', { request_id: r.pending_requests[0].request_id, decision: 'decline', wait_seconds: 5 });
  assert.equal(done.status, 'completed');
  assert.equal(done.latest_message, 'decision=decline');
  assert.equal(done.commands_run, 0);
});

test('approval "never" auto-accepts', async () => {
  const r = await call('codex_run', { cwd: '/tmp', prompt: 'approve', approval: 'never', wait_seconds: 5 });
  assert.equal(r.status, 'completed');
  assert.equal(r.latest_message, 'decision=accept');
  assert.equal(r.commands_run, 1);
});

test('approval can change between turns on a loaded thread; sandbox cannot', async () => {
  const r = await call('codex_run', { cwd: '/tmp', prompt: 'echo hi', approval: 'never', wait_seconds: 5 });
  const r2 = await call('codex_run', { thread_id: r.thread_id, prompt: 'approve', approval: 'on-request', wait_seconds: 5 });
  assert.equal(r2.status, 'waitingForInput');
  await call('codex_respond', { request_id: r2.pending_requests[0].request_id, decision: 'cancel', wait_seconds: 5 });
  await assert.rejects(call('codex_run', { thread_id: r.thread_id, prompt: 'echo x', sandbox: 'read-only' }), /sandbox is fixed/);
});

test('a stricter approval policy applies to requests that arrive before turn/start response', async () => {
  const r = await call('codex_run', { cwd: '/tmp', prompt: 'echo hi', approval: 'never', wait_seconds: 5 });
  const r2 = await call('codex_run', { thread_id: r.thread_id, prompt: 'approve-early', approval: 'on-request', wait_seconds: 5 });
  assert.equal(r2.status, 'waitingForInput');
  assert.equal(r2.pending_requests[0].command, 'curl evil');
  await call('codex_respond', { request_id: r2.pending_requests[0].request_id, decision: 'decline', wait_seconds: 5 });
});

test('questions are answered through codex_respond', async () => {
  const r = await call('codex_run', { cwd: '/tmp', prompt: 'ask', wait_seconds: 5 });
  const q = r.pending_requests[0];
  assert.equal(q.type, 'question');
  assert.equal(q.questions[0].id, 'color');
  await assert.rejects(call('codex_respond', { request_id: q.request_id, decision: 'accept' }), /answers/);
  const done = await call('codex_respond', { request_id: q.request_id, answers: { color: 'blue' }, wait_seconds: 5 });
  assert.equal(done.latest_message, 'answer=blue');
});

test('status shows live activity; steer finishes the turn; run refuses while busy', async () => {
  const r = await call('codex_run', { cwd: '/tmp', prompt: 'slow', wait_seconds: 0 });
  await new Promise((res) => setTimeout(res, 100));
  const [s] = await call('codex_status', { thread_ids: [r.thread_id] });
  assert.equal(s.status, 'inProgress');
  assert.deepEqual(s.current_activity, ['running: make build']);
  await assert.rejects(call('codex_run', { thread_id: r.thread_id, prompt: 'echo x' }), /codex_steer/);
  const done = await call('codex_steer', { thread_id: r.thread_id, prompt: 'wrap up', wait_seconds: 5 });
  assert.equal(done.status, 'completed');
  assert.equal(done.latest_message, 'steered=wrap up');
});

test('interrupt and batch wait', async () => {
  const a = await call('codex_run', { cwd: '/tmp', prompt: 'slow', wait_seconds: 0 });
  const b = await call('codex_run', { cwd: '/tmp', prompt: 'echo b', wait_seconds: 0 });
  const any = await call('codex_wait', { thread_ids: [a.thread_id, b.thread_id], mode: 'any', wait_seconds: 5 });
  assert.deepEqual(
    any.map((x) => x.status),
    ['inProgress', 'completed'],
  );
  const stopped = await call('codex_interrupt', { thread_id: a.thread_id });
  assert.equal(stopped.status, 'interrupted');
});

test('review: native target, and focus/adversarial become custom instructions', async () => {
  const plain = await call('codex_review', { cwd: '/tmp', target: 'base', base_branch: 'main', wait_seconds: 5 });
  assert.equal(plain.review, 'REVIEW {"type":"baseBranch","branch":"main"}');
  const adv = await call('codex_review', { cwd: '/tmp', adversarial: true, focus: 'error handling', wait_seconds: 5 });
  assert.match(adv.review, /"type":"custom"/);
  assert.match(adv.review, /uncommitted changes.*skeptical.*Focus on: error handling/);
  await assert.rejects(call('codex_review', { cwd: '/tmp', target: 'commit' }), /commit_sha/);
});

test('models, threads, compact', async () => {
  const [m] = await call('codex_models', {});
  assert.deepEqual(m.efforts, ['low', 'medium']);
  const [t] = await call('codex_threads', { limit: 5 });
  assert.equal(t.thread_id, 'thread_0');
  assert.equal((await call('codex_compact', { thread_id: t.thread_id })).compaction, 'started');
});

test('worktree lifecycle: create, list, diff, safe remove guard, and delete_branch', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'codex-mcp-repo-'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    // Unborn HEAD should produce a clear error
    await assert.rejects(call('codex_run', { cwd: repo, prompt: 'echo wt', worktree: true }), /no commits yet/);

    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git('add', 'README.md');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    execFileSync('mkdir', [join(repo, 'sub')]);
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');

    const r = await call('codex_run', { cwd: join(repo, 'sub'), prompt: 'echo wt', worktree: true, wait_seconds: 5 });
    assert.match(r.worktree.branch, /^codex\//);
    assert.equal(r.worktree.parent_dirty, true);
    assert.equal(r.worktree.cwd, join(r.worktree.path, 'sub'));
    assert.ok(existsSync(r.worktree.path));
    assert.ok(existsSync(r.worktree.cwd));

    const listed = await call('codex_worktree', { action: 'list', cwd: repo });
    assert.ok(listed.worktrees.some((w) => w.path === r.worktree.path));

    // Modify file inside worktree and verify diff + dirty removal guard
    writeFileSync(join(r.worktree.path, 'README.md'), 'changed\n');
    const diffRes = await call('codex_worktree', { action: 'diff', path: r.worktree.path });
    assert.match(diffRes.diff, /\+changed/);
    assert.match(diffRes.status_short, /M README\.md/);

    await assert.rejects(call('codex_worktree', { action: 'remove', path: r.worktree.path }), /uncommitted changes/);

    const removed = await call('codex_worktree', {
      action: 'remove',
      path: r.worktree.path,
      force: true,
      delete_branch: true,
    });
    assert.equal(removed.branch_deleted, true);
    assert.equal(existsSync(r.worktree.path), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('PATH helpers keep node dir and avoid duplicates', () => {
  const env = buildChildEnv('/custom/bin/codex', { PATH: '/usr/bin:/bin' });
  const parts = env.PATH.split(delimiter);
  assert.ok(parts.includes(dirname(process.execPath)));
  assert.ok(parts.includes('/custom/bin'));
  assert.equal(new Set(parts).size, parts.length);
  assert.equal(resolveCodexBin('/explicit/codex'), '/explicit/codex');
});

// last: kills the fake app-server
test('app-server crash fails the running turn, the bridge respawns, threads keep their sandbox', async () => {
  const ro = await call('codex_run', { cwd: '/tmp', prompt: 'echo ro', sandbox: 'read-only', wait_seconds: 5 });
  const r = await call('codex_run', { cwd: '/tmp', prompt: 'crash', wait_seconds: 5 });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /exited/);
  const again = await call('codex_run', { cwd: '/tmp', prompt: 'echo back', wait_seconds: 5 });
  assert.equal(again.latest_message, 'back');
  const resumed = await call('codex_run', { thread_id: ro.thread_id, prompt: 'policy', wait_seconds: 5 });
  assert.equal(resumed.latest_message, 'sandbox=read-only');
});
