// Offline tests: real MCP server against fake `codex app-server` + worktree/env/bridge unit tests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AppServer, buildChildEnv, OPT_OUT_NOTIFICATIONS, resolveCodexBin } from '../lib/app-server.mjs';
import { Bridge } from '../lib/bridge.mjs';
import { createWorktree, inspectWorktreeDiff, listWorktrees, removeWorktree, WORKTREE_META_ROOT, WORKTREE_ROOT } from '../lib/worktree.mjs';

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

test('exposes every expected MCP tool, server version 0.2.1, and instructions', async () => {
  assert.equal(client.getServerVersion()?.version, '0.2.1');
  assert.match(client.getInstructions() ?? '', /codex_run/);
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
  assert.equal(r.model, 'fake-model');
  assert.deepEqual(r.files_changed, [{ path: 'src/app.js', type: 'modified' }]);
  assert.match(r.diff_preview, /\+new/);
  assert.deepEqual(r.token_usage, { input: 100, cached: 20, cache_write: 5, output: 30, reasoning: 10, cache_hit_rate: 20 });
});

test('forwards localImage paths via images option and rejects invalid run combos/missing images', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-img-'));
  const repo = mkdtempSync(join(tmpdir(), 'codex-mcp-imgrepo-'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  try {
    const imgA = join(dir, 'a.png');
    const imgB = join(dir, 'b.png');
    writeFileSync(imgA, 'fake-png-a');
    writeFileSync(imgB, 'fake-png-b');
    const r = await call('codex_run', {
      cwd: '/tmp',
      prompt: 'check-image',
      images: [imgA, imgB],
      wait_seconds: 5,
    });
    assert.equal(r.latest_message, `images=${imgA},${imgB}`);

    await assert.rejects(call('codex_run', { thread_id: r.thread_id, prompt: 'echo x', worktree: true }), /worktree cannot be combined with thread_id/);
    await assert.rejects(call('codex_run', { thread_id: r.thread_id, prompt: 'echo x', web_search: true }), /web_search cannot be combined with thread_id/);

    git('init', '-q');
    writeFileSync(join(repo, 'README.md'), 'init\n');
    git('add', 'README.md');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    await assert.rejects(
      call('codex_run', { cwd: repo, prompt: 'check-image', images: [join(dir, 'missing.png')], worktree: true }),
      /image path does not exist/,
    );
    assert.equal(listWorktrees(repo).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
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

test('concurrent codex_run on same thread_id is rejected while turn/start is in-flight', async () => {
  const init = await call('codex_run', { cwd: '/tmp', prompt: 'echo init', wait_seconds: 5 });
  const [first, second] = await Promise.allSettled([
    call('codex_run', { thread_id: init.thread_id, prompt: 'delay-turn-start', wait_seconds: 5 }),
    call('codex_run', { thread_id: init.thread_id, prompt: 'echo race', wait_seconds: 5 }),
  ]);
  const fulfilled = [first, second].filter((x) => x.status === 'fulfilled');
  const rejected = [first, second].filter((x) => x.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(fulfilled[0].value.latest_message, 'delayed-ok');
  assert.match(rejected[0].reason.message, /already has a running turn/);
});

test('interrupt, batch wait, and codex_wait thread_ids deduplication preserving order', async () => {
  const a = await call('codex_run', { cwd: '/tmp', prompt: 'slow', wait_seconds: 0 });
  const b = await call('codex_run', { cwd: '/tmp', prompt: 'echo b', wait_seconds: 0 });
  const any = await call('codex_wait', { thread_ids: [a.thread_id, b.thread_id], mode: 'any', wait_seconds: 5 });
  assert.deepEqual(
    any.map((x) => x.status),
    ['inProgress', 'completed'],
  );
  const stopped = await call('codex_interrupt', { thread_id: a.thread_id });
  assert.equal(stopped.status, 'interrupted');

  const deduped = await call('codex_wait', { thread_ids: [b.thread_id, a.thread_id, b.thread_id], wait_seconds: 5 });
  assert.deepEqual(
    deduped.map((x) => x.thread_id),
    [b.thread_id, a.thread_id],
  );
});

test('review: native target, focus/adversarial, pre-validation without leak, and review/start failure', async () => {
  const plain = await call('codex_review', { cwd: '/tmp', target: 'base', base_branch: 'main', wait_seconds: 5 });
  assert.equal(plain.review, 'REVIEW {"type":"baseBranch","branch":"main"}');
  const adv = await call('codex_review', { cwd: '/tmp', adversarial: true, focus: 'error handling', wait_seconds: 5 });
  assert.match(adv.review, /"type":"custom"/);
  assert.match(adv.review, /uncommitted changes.*skeptical.*Focus on: error handling/);

  const beforeIds = new Set((await call('codex_status', {})).map((t) => t.thread_id));
  await assert.rejects(call('codex_review', { cwd: '/tmp', target: 'commit' }), /commit_sha/);
  await assert.rejects(call('codex_review', { cwd: '/nonexistent/codex-review-dir', target: 'uncommitted' }), /does not exist/);
  const afterIds = (await call('codex_status', {})).map((t) => t.thread_id);
  assert.deepEqual(afterIds.filter((id) => !beforeIds.has(id)), []);

  await assert.rejects(call('codex_review', { cwd: '/tmp', focus: 'fail-review-start', wait_seconds: 5 }), /simulated review\/start failure/);
  const afterFail = await call('codex_status', {});
  const failedReviewThread = afterFail.find((t) => !beforeIds.has(t.thread_id));
  assert.ok(failedReviewThread);
  assert.equal(failedReviewThread.status, 'failed');
  assert.match(failedReviewThread.error, /simulated review\/start failure/);
});

test('models, threads, compact', async () => {
  const [m] = await call('codex_models', {});
  assert.deepEqual(m.efforts, ['low', 'medium']);
  const [t] = await call('codex_threads', { limit: 5 });
  assert.equal(t.thread_id, 'thread_0');
  assert.equal((await call('codex_compact', { thread_id: t.thread_id })).compaction, 'started');
});

test('worktree lifecycle: create, clean status, committed+uncommitted diff, UTF-8 byte truncation, detached remove, and delete_branch', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'codex-mcp-repo-'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  let wtPath = null;
  try {
    git('init', '-q');
    // Unborn HEAD should produce a clear error
    await assert.rejects(call('codex_run', { cwd: repo, prompt: 'echo wt', worktree: true }), /no commits yet/);

    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git('add', 'README.md');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    const baseHead = git('rev-parse', 'HEAD');
    execFileSync('mkdir', [join(repo, 'sub')]);
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');

    const r = await call('codex_run', { cwd: join(repo, 'sub'), prompt: 'echo wt', worktree: true, wait_seconds: 5 });
    wtPath = r.worktree.path;
    assert.match(r.worktree.branch, /^codex\//);
    assert.equal(r.worktree.parent_dirty, true);
    assert.equal(r.worktree.base_head, baseHead);
    assert.equal(r.worktree.cwd, join(r.worktree.path, 'sub'));
    assert.ok(existsSync(r.worktree.path));
    assert.ok(existsSync(r.worktree.cwd));
    // Sidecar metadata lives outside the worktree so git status stays 100% clean
    const metaFile = join(WORKTREE_META_ROOT, `${basename(r.worktree.path)}.json`);
    assert.ok(existsSync(metaFile));
    assert.equal(execFileSync('git', ['-C', r.worktree.path, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '');

    const listed = await call('codex_worktree', { action: 'list', cwd: repo });
    const entry = listed.worktrees.find((w) => w.path === r.worktree.path);
    assert.ok(entry);
    assert.equal(entry.base_head, baseHead);
    assert.equal(entry.repo_root, realpathSync(repo));

    // Commit multi-byte UTF-8 changes on the worktree branch AND leave uncommitted edits
    const wtGit = (...a) => execFileSync('git', ['-C', r.worktree.path, ...a], { encoding: 'utf8' }).trim();
    writeFileSync(join(r.worktree.path, 'utf8.txt'), '🚀中文测试内容'.repeat(15) + '\n');
    wtGit('add', 'utf8.txt');
    wtGit('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'wt branch commit');
    writeFileSync(join(r.worktree.path, 'README.md'), 'changed\n');

    const diffRes = await call('codex_worktree', { action: 'diff', path: r.worktree.path });
    assert.equal(diffRes.base_head, baseHead);
    assert.match(diffRes.commits_ahead, /wt branch commit/);
    assert.match(diffRes.diff, /\+changed/);
    assert.match(diffRes.diff, /🚀中文测试内容/);
    assert.match(diffRes.status_short, /M README\.md/);

    // Verify UTF-8 byte-exact truncation never emits U+FFFD replacement chars across any byte boundary
    const headerLen = Buffer.byteLength(diffRes.diff.split('🚀')[0], 'utf8');
    for (const offset of [1, 2, 3, 5, 6]) {
      const cut = inspectWorktreeDiff(r.worktree.path, { maxBytes: headerLen + offset });
      assert.equal(cut.truncated, true);
      assert.ok(cut.diff.endsWith('\n... [truncated]'));
      const prefix = cut.diff.slice(0, cut.diff.length - '\n... [truncated]'.length);
      assert.ok(Buffer.byteLength(prefix, 'utf8') <= headerLen + offset);
      assert.equal(prefix.includes('\ufffd'), false);
    }

    await assert.rejects(call('codex_worktree', { action: 'remove', path: r.worktree.path }), /uncommitted changes/);

    // Even if detached HEAD, sidecar metadata authorizes removal and cleans up the sidecar + branch
    wtGit('checkout', '--quiet', '--detach');
    const removed = await call('codex_worktree', {
      action: 'remove',
      path: r.worktree.path,
      force: true,
      delete_branch: true,
    });
    wtPath = null;
    assert.equal(removed.branch_deleted, true);
    assert.equal(existsSync(r.worktree.path), false);
    assert.equal(existsSync(metaFile), false);
  } finally {
    if (wtPath && existsSync(wtPath)) {
      try {
        removeWorktree(wtPath, { force: true, deleteBranch: true });
      } catch {}
    }
    rmSync(repo, { recursive: true, force: true });
  }
});

test('worktree rollback on thread/start failure leaves zero worktrees, branches, or metadata', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'codex-mcp-rollback-'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  const worktreesBefore = new Set(listWorktrees().map((w) => w.path));
  try {
    git('init', '-q');
    writeFileSync(join(repo, '.fail-thread-start'), '1\n');
    git('add', '.fail-thread-start');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

    await assert.rejects(
      call('codex_run', { cwd: repo, prompt: 'echo fail', worktree: true }),
      /simulated thread\/start failure/,
    );

    assert.equal(git('branch', '--list', 'codex/*'), '');
    assert.equal(listWorktrees(repo).length, 0);
    const worktreesAfter = listWorktrees().map((w) => w.path);
    assert.deepEqual(
      worktreesAfter.filter((p) => !worktreesBefore.has(p)),
      [],
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('removeWorktree blocks external codex/* branches, symlink escapes, and main repos; allows legacy managed worktrees', () => {
  const base = mkdtempSync(join(tmpdir(), 'codex-mcp-sec-'));
  const extRepo = join(base, 'ext-repo');
  const extWt = join(base, 'ext-wt');
  const symlinkWt = join(WORKTREE_ROOT, `symlink-escape-${Date.now()}`);
  const trapRepo = join(WORKTREE_ROOT, `trap-main-${Date.now()}`);
  const legacyWt = join(WORKTREE_ROOT, `legacy-wt-${Date.now()}`);
  mkdirSync(WORKTREE_ROOT, { recursive: true });
  try {
    mkdirSync(extRepo);
    const gitExt = (...a) => execFileSync('git', ['-C', extRepo, ...a], { encoding: 'utf8' }).trim();
    gitExt('init', '-q');
    writeFileSync(join(extRepo, 'a.txt'), 'a\n');
    gitExt('add', 'a.txt');
    gitExt('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    gitExt('worktree', 'add', '-b', 'codex/external-branch', extWt, 'HEAD');

    // 1. External worktree with codex/* branch must be rejected
    assert.throws(() => removeWorktree(extWt, { force: true }), /refusing to remove non-Codex worktree/);
    assert.ok(existsSync(extWt));

    // 2. Symlink inside WORKTREE_ROOT pointing outside must be rejected
    symlinkSync(extWt, symlinkWt);
    assert.throws(() => removeWorktree(symlinkWt, { force: true }), /refusing to remove non-Codex worktree/);
    assert.ok(existsSync(extWt));

    // 3. Main repository placed directly inside WORKTREE_ROOT on a codex/* branch must be rejected
    mkdirSync(trapRepo);
    execFileSync('git', ['-C', trapRepo, 'init', '-q']);
    execFileSync('git', ['-C', trapRepo, 'checkout', '-q', '-b', 'codex/main-trap']);
    writeFileSync(join(trapRepo, 'b.txt'), 'b\n');
    execFileSync('git', ['-C', trapRepo, 'add', 'b.txt']);
    execFileSync('git', ['-C', trapRepo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init']);
    assert.throws(() => removeWorktree(trapRepo, { force: true }), /refusing to remove non-Codex worktree/);
    assert.ok(existsSync(trapRepo));

    // 4. Legacy managed linked worktree directly in WORKTREE_ROOT with codex/* branch (no sidecar) still works
    gitExt('worktree', 'add', '-b', 'codex/legacy-managed', legacyWt, 'HEAD');
    const removedLegacy = removeWorktree(legacyWt, { force: true, deleteBranch: true });
    assert.equal(removedLegacy.branch_deleted, true);
    assert.equal(existsSync(legacyWt), false);
  } finally {
    rmSync(symlinkWt, { force: true });
    rmSync(trapRepo, { recursive: true, force: true });
    if (existsSync(legacyWt)) {
      try {
        execFileSync('git', ['-C', extRepo, 'worktree', 'remove', '--force', legacyWt]);
      } catch {}
    }
    if (existsSync(extWt)) {
      try {
        execFileSync('git', ['-C', extRepo, 'worktree', 'remove', '--force', extWt]);
      } catch {}
    }
    rmSync(base, { recursive: true, force: true });
  }
});

test('PATH helpers preserve user PATH precedence, support slash and backslash bins, and avoid duplicates', () => {
  // Stripped GUI PATH appends node dir, bin dir, /opt/homebrew/bin, /usr/local/bin after existing entries
  const stripped = buildChildEnv('/custom/bin/codex', { PATH: '/usr/bin:/bin' });
  const strippedParts = stripped.PATH.split(delimiter);
  assert.equal(strippedParts[0], '/usr/bin');
  assert.equal(strippedParts[1], '/bin');
  assert.ok(strippedParts.includes(dirname(process.execPath)));
  assert.ok(strippedParts.includes('/custom/bin'));
  assert.ok(strippedParts.includes('/opt/homebrew/bin'));
  assert.ok(strippedParts.includes('/usr/local/bin'));
  assert.equal(new Set(strippedParts).size, strippedParts.length);

  // User-configured custom bin stays ahead of /opt/homebrew/bin and /usr/local/bin
  const custom = buildChildEnv('/opt/homebrew/bin/codex', { PATH: '/custom/user/bin:/usr/bin' });
  const customParts = custom.PATH.split(delimiter);
  assert.equal(customParts[0], '/custom/user/bin');
  assert.ok(customParts.indexOf('/custom/user/bin') < customParts.indexOf('/opt/homebrew/bin'));
  assert.ok(customParts.indexOf('/custom/user/bin') < customParts.indexOf('/usr/local/bin'));

  // Bare command name never adds '.' to PATH; backslash paths extract Windows dirname cleanly without '.'
  const bare = buildChildEnv('codex', { PATH: '/usr/bin' });
  assert.equal(bare.PATH.split(delimiter).includes('.'), false);
  const winRel = buildChildEnv('custom\\bin\\codex.exe', { PATH: '/usr/bin' });
  assert.ok(winRel.PATH.split(delimiter).includes('custom\\bin'));
  assert.equal(winRel.PATH.split(delimiter).includes('.'), false);
  const winAbs = buildChildEnv('C:\\tools\\codex.exe', { PATH: '/usr/bin' });
  assert.ok(winAbs.PATH.includes('C:\\tools'));
  assert.equal(winAbs.PATH.split(delimiter).includes('.'), false);

  assert.equal(resolveCodexBin('/explicit/codex'), '/explicit/codex');
});

test('launch-mcp.sh preserves existing PATH precedence and resolves nvm default and reverse-version order', () => {
  const base = mkdtempSync(join(tmpdir(), 'codex-mcp-launch-'));
  const userBin = join(base, 'user-bin');
  const home = join(base, 'home');
  const launchScript = path('../scripts/launch-mcp.sh');
  try {
    mkdirSync(userBin, { recursive: true });
    const stubNode = join(userBin, 'node');
    writeFileSync(stubNode, '#!/bin/sh\nprintf "%s\\n" "$PATH"\n', { mode: 0o755 });
    for (const ver of ['v18.20.0', 'v20.18.0', 'v22.1.0']) {
      mkdirSync(join(home, '.nvm', 'versions', 'node', ver, 'bin'), { recursive: true });
    }
    mkdirSync(join(home, '.nvm', 'alias', 'lts'), { recursive: true });
    writeFileSync(join(home, '.nvm', 'alias', 'default'), 'lts/*\n');
    writeFileSync(join(home, '.nvm', 'alias', 'lts', '*'), 'lts/iron\n');
    writeFileSync(join(home, '.nvm', 'alias', 'lts', 'iron'), '20\n');

    const withDefault = execFileSync('/bin/sh', [launchScript], {
      env: { HOME: home, PATH: `${userBin}:/usr/bin:/bin` },
      encoding: 'utf8',
    })
      .trim()
      .split(':');
    assert.equal(withDefault[0], userBin);
    assert.ok(withDefault.includes(join(home, '.nvm', 'versions', 'node', 'v20.18.0', 'bin')));
    assert.equal(withDefault.includes(join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin')), false);

    rmSync(join(home, '.nvm', 'alias', 'default'));
    const withoutDefault = execFileSync('/bin/sh', [launchScript], {
      env: { HOME: home, PATH: `${userBin}:/usr/bin:/bin` },
      encoding: 'utf8',
    })
      .trim()
      .split(':');
    assert.equal(withoutDefault[0], userBin);
    const i22 = withoutDefault.indexOf(join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin'));
    const i20 = withoutDefault.indexOf(join(home, '.nvm', 'versions', 'node', 'v20.18.0', 'bin'));
    const i18 = withoutDefault.indexOf(join(home, '.nvm', 'versions', 'node', 'v18.20.0', 'bin'));
    assert.ok(i22 > 0 && i20 > i22 && i18 > i20);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('AppServer handles initialize timeout kill+respawn, RPC timeout, handler error separation, and ENOENT without EPIPE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-app-'));
  const hangMarker = join(dir, 'hang-once');
  try {
    writeFileSync(hangMarker, '1');
    const app = new AppServer(
      path('./fake-codex.mjs'),
      { onNotification: () => {}, onServerRequest: () => {}, onExit: () => {} },
      { rpcTimeoutMs: 150, env: { ...process.env, CODEX_FAKE_HANG_ONCE_FILE: hangMarker } },
    );
    await assert.rejects(app.call('model/list', {}), /initialize timed out after 150ms/);
    assert.equal(app.proc, null);
    assert.equal(app.ready, null);
    // Next call respawns cleanly once the wedged child was killed
    const models = await app.call('model/list', {});
    assert.ok(Array.isArray(models.data));
    await app.close();

    // Normal RPC timeout deletes pending entry and rejects clearly
    const hangingRpc = new AppServer(
      path('./fake-codex.mjs'),
      { onNotification: () => {}, onServerRequest: () => {}, onExit: () => {} },
      { rpcTimeoutMs: 5000, env: { ...process.env, CODEX_FAKE_HANG_METHOD: 'model/list' } },
    );
    await hangingRpc.start();
    await assert.rejects(hangingRpc.request('model/list', {}, 120), /model\/list timed out after 120ms/);
    assert.equal(hangingRpc.pending.size, 0);
    await hangingRpc.close();

    // Throwing notification handler and non-JSON stdout do not crash AppServer
    let sawThrow = false;
    const resilient = new AppServer(path('./fake-codex.mjs'), {
      onNotification: (method) => {
        if (method === 'turn/started') {
          sawThrow = true;
          throw new Error('boom inside handler');
        }
      },
      onServerRequest: () => {},
      onExit: () => {},
    });
    const t = await resilient.call('thread/start', { cwd: '/tmp', sandbox: 'workspace-write', approvalPolicy: 'on-request' });
    await resilient.call('turn/start', { threadId: t.thread.id, input: [{ type: 'text', text: 'bad-json-then-ok' }] });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(sawThrow, true);
    const stillAlive = await resilient.call('model/list', {});
    assert.ok(stillAlive.data.length > 0);
    await resilient.close();

    // Missing binary spawn error + stdin EPIPE never crashes the process
    const badBin = new AppServer('/nonexistent/codex-bin-xyz', {
      onNotification: () => {},
      onServerRequest: () => {},
      onExit: () => {},
    });
    await assert.rejects(badBin.call('model/list', {}), /failed to spawn/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Bridge ensures single thread/resume, prunes prior turns, caps diffs at 64KiB, clears requests on completion, preserves fatal errors, and evicts settled threads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-mcp-bridge-'));
  const logFile = join(dir, 'rpc.log');
  const bridge = new Bridge({
    bin: path('./fake-codex.mjs'),
    sandbox: 'workspace-write',
    approval: 'on-request',
    maxThreads: 3,
    env: { ...process.env, CODEX_FAKE_LOG_FILE: logFile, CODEX_FAKE_RESUME_DELAY_MS: '60' },
  });
  try {
    // 1. Deduplicate concurrent ensureLoaded calls
    await Promise.all([bridge.ensureLoaded('thread_0'), bridge.ensureLoaded('thread_0')]);
    assert.equal(readFileSync(logFile, 'utf8').trim().split('\n').length, 1);

    // 2. Prune prior turn items/diffs on turn/started, cap turnDiff at 65536 bytes, clear requests on turn/completed
    bridge.onNotification('turn/started', { threadId: 't_mem', turn: { id: 'turn_1' } });
    bridge.onNotification('item/completed', { threadId: 't_mem', turnId: 'turn_1', item: { type: 'agentMessage', text: 'old' } });
    bridge.onNotification('turn/diff/updated', { threadId: 't_mem', turnId: 'turn_1', diff: 'old-diff' });
    bridge.requests.set('req_stale', { rawId: 999, threadId: 't_mem', method: 'item/commandExecution/requestApproval', params: {}, summary: {} });

    bridge.onNotification('turn/started', { threadId: 't_mem', turn: { id: 'turn_2' } });
    assert.equal(bridge.state('t_mem').items.length, 0);
    assert.equal(bridge.state('t_mem').turnDiffs.has('turn_1'), false);

    const bigUtf8Diff = '🚀中文diff'.repeat(10000);
    bridge.onNotification('turn/diff/updated', { threadId: 't_mem', turnId: 'turn_2', diff: bigUtf8Diff });
    const storedDiff = bridge.state('t_mem').turnDiffs.get('turn_2');
    assert.ok(Buffer.byteLength(storedDiff, 'utf8') <= 65536);
    assert.ok(storedDiff.endsWith('\n... [truncated]'));
    assert.equal(storedDiff.includes('\ufffd'), false);

    bridge.onNotification('turn/completed', { threadId: 't_mem', turn: { id: 'turn_2', status: 'completed', error: null } });
    assert.equal(bridge.pendingFor('t_mem').length, 0);

    // 3. error notification with willRetry: false is preserved across failed turn/completed
    const fatalId = await bridge.startThread({ cwd: '/tmp' });
    await bridge.startTurn(fatalId, { prompt: 'error-fatal' });
    await bridge.wait([fatalId], 5);
    const fatalReport = bridge.report(fatalId);
    assert.equal(fatalReport.status, 'failed');
    assert.equal(fatalReport.error, 'fatal upstream error');

    // 4. maxThreads eviction keeps inProgress thread and evicts oldest settled thread
    bridge.state('t_mem').status = 'inProgress';
    await bridge.startThread({ cwd: '/tmp' }); // pushes past maxThreads (3), evicting oldest settled (thread_0)
    assert.equal(bridge.threads.size, 3);
    assert.equal(bridge.threads.has('t_mem'), true);
    assert.equal(bridge.threads.has('thread_0'), false);
  } finally {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prompt cache preservation: thread/start sets model/effort, follow-ups avoid redundant overrides or default clobbering, and initialize opts out of deltas', async () => {
  // 1. Over MCP: new thread sets model/effort on thread/start with zero redundant overrides on turn/start
  const t1 = await call('codex_run', {
    cwd: '/tmp',
    model: 'gpt-6.2-sol',
    effort: 'low',
    prompt: 'inspect-meta',
    wait_seconds: 5,
  });
  assert.equal(t1.model, 'gpt-6.2-sol');
  const m1 = JSON.parse(t1.latest_message);
  assert.deepEqual(m1.initCapabilities.optOutNotificationMethods, OPT_OUT_NOTIFICATIONS);
  assert.equal(m1.meta.startModel, 'gpt-6.2-sol');
  assert.equal(m1.meta.startEffort, 'low');
  assert.deepEqual(m1.meta.lastTurnParams, { model: null, effort: null, cwd: null, approvalPolicy: null });

  // 2. Follow-up with identical model/effort and symlinked realpath cwd sends zero redundant overrides
  const t2 = await call('codex_run', {
    thread_id: t1.thread_id,
    cwd: realpathSync('/tmp'),
    model: 'gpt-6.2-sol',
    effort: 'low',
    prompt: 'inspect-meta',
    wait_seconds: 5,
  });
  const m2 = JSON.parse(t2.latest_message);
  assert.deepEqual(m2.meta.lastTurnParams, { model: null, effort: null, cwd: null, approvalPolicy: null });

  // 3. Explicit follow-up model/effort change IS forwarded and remembered
  const t3 = await call('codex_run', {
    thread_id: t1.thread_id,
    model: 'gpt-6.2-astra',
    effort: 'high',
    prompt: 'inspect-meta',
    wait_seconds: 5,
  });
  assert.equal(t3.model, 'gpt-6.2-astra');
  const m3 = JSON.parse(t3.latest_message);
  assert.deepEqual(m3.meta.lastTurnParams, { model: 'gpt-6.2-astra', effort: 'high', cwd: null, approvalPolicy: null });

  // 4. Bridge with explicit default model/effort does NOT clobber a thread's custom model/effort on follow-up or post-crash resume
  const bridge = new Bridge({
    bin: path('./fake-codex.mjs'),
    sandbox: 'workspace-write',
    approval: 'on-request',
    model: 'default-model',
    effort: 'xhigh',
  });
  try {
    const customId = await bridge.startThread({ cwd: '/tmp', model: 'gpt-6-luna', effort: 'low' });
    await bridge.startTurn(customId, { prompt: 'inspect-meta' });
    await bridge.wait([customId], 5);
    const b1 = JSON.parse(bridge.report(customId).latest_message);
    assert.equal(b1.meta.startModel, 'gpt-6-luna');
    assert.equal(b1.meta.startEffort, 'low');
    assert.deepEqual(b1.meta.lastTurnParams, { model: null, effort: null, cwd: null, approvalPolicy: null });

    // Crash app-server and resume customId without specifying model/effort → preserves gpt-6-luna + low!
    const crashId = await bridge.startThread({ cwd: '/tmp' });
    await bridge.startTurn(crashId, { prompt: 'crash' });
    await bridge.wait([crashId], 5);

    await bridge.ensureLoaded(customId);
    await bridge.startTurn(customId, { prompt: 'inspect-meta' });
    await bridge.wait([customId], 5);
    const b2 = JSON.parse(bridge.report(customId).latest_message);
    assert.equal(b2.meta.resumeModel, 'gpt-6-luna');
    assert.equal(b2.meta.resumeEffort, 'low');
    assert.deepEqual(b2.meta.lastTurnParams, { model: null, effort: null, cwd: null, approvalPolicy: null });
    assert.equal(bridge.report(customId).model, 'gpt-6-luna');
  } finally {
    await bridge.close();
  }
});

test('onExit fails threads awaiting approval input and clears stale requests', async () => {
  const waiting = await call('codex_run', { cwd: '/tmp', prompt: 'approve', wait_seconds: 5 });
  assert.equal(waiting.status, 'waitingForInput');
  const reqId = waiting.pending_requests[0].request_id;

  const crashed = await call('codex_run', { cwd: '/tmp', prompt: 'crash', wait_seconds: 5 });
  assert.equal(crashed.status, 'failed');

  const [afterCrash] = await call('codex_status', { thread_ids: [waiting.thread_id] });
  assert.equal(afterCrash.status, 'failed');
  assert.equal(afterCrash.error, 'codex app-server exited while awaiting input');
  assert.equal(afterCrash.pending_requests, undefined);
  await assert.rejects(call('codex_respond', { request_id: reqId, decision: 'accept' }), /no pending request/);
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
