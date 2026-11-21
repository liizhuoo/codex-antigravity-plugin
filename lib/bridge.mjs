// Thread/turn bookkeeping on top of AppServer: accumulates items and diffs per turn,
// queues server-initiated requests (approvals, questions) for the MCP client to answer,
// and lets callers wait on turns.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppServer, log } from './app-server.mjs';
import { createWorktree, removeWorktree, truncateUtf8 } from './worktree.mjs';

export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
export const APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'];

const MAX_TURN_DIFF_BYTES = 65536;
const TRUNCATED_MARKER = '\n... [truncated]';
const MAX_TURN_DIFF_PAYLOAD_BYTES = MAX_TURN_DIFF_BYTES - Buffer.byteLength(TRUNCATED_MARKER, 'utf8');

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
]);

const ADVERSARIAL_PREAMBLE =
  'Act as a skeptical senior reviewer. Do not just look for bugs: challenge the chosen approach, ' +
  'question assumptions and tradeoffs, look for failure modes, and say whether a simpler or safer design exists.';

function assertValidCwd(cwd) {
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`cwd does not exist or is not a directory: ${cwd}`);
  }
}

function canonicalPath(p) {
  if (!p) return null;
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function sameCwd(a, b) {
  if (!a || !b) return false;
  return canonicalPath(a) === canonicalPath(b);
}

function parseDiffFiles(diffText) {
  if (!diffText) return [];
  const files = new Set();
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ b/')) {
      files.add(line.slice(6));
    } else if (line.startsWith('diff --git a/')) {
      const match = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      if (match) files.add(match[1]);
    }
  }
  return [...files];
}

function summarizeItem(item) {
  switch (item.type) {
    case 'agentMessage':
      return { kind: 'message', text: item.text };
    case 'commandExecution':
      return { kind: 'command', command: item.command, exitCode: item.exitCode, status: item.status };
    case 'fileChange':
      return { kind: 'files', status: item.status, changes: item.changes.map((c) => ({ path: c.path, type: c.kind.type })) };
    case 'mcpToolCall':
      return { kind: 'tool', name: `${item.server}.${item.tool}`, status: item.status };
    case 'webSearch':
      return { kind: 'tool', name: 'webSearch' };
    case 'exitedReviewMode':
      return { kind: 'review', text: item.review };
    default:
      return null;
  }
}

function describeActive(item) {
  switch (item.type) {
    case 'commandExecution':
      return `running: ${item.command}`;
    case 'fileChange':
      return `editing: ${item.changes.map((c) => c.path).join(', ')}`;
    case 'mcpToolCall':
      return `tool: ${item.server}.${item.tool}`;
    case 'webSearch':
      return 'searching the web';
    case 'reasoning':
      return 'thinking';
    case 'enteredReviewMode':
      return 'reviewing';
    default:
      return null;
  }
}

function summarizeRequest(method, p) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { type: 'approve_command', command: p.command, cwd: p.cwd, reason: p.reason ?? null };
    case 'execCommandApproval':
      return { type: 'approve_command', command: p.command?.join?.(' ') ?? p.command, cwd: p.cwd, reason: p.reason ?? null };
    case 'item/fileChange/requestApproval':
      return { type: 'approve_file_change', reason: p.reason ?? null, grant_root: p.grantRoot ?? null };
    case 'applyPatchApproval':
      return { type: 'approve_file_change', files: Object.keys(p.fileChanges ?? {}), reason: p.reason ?? null };
    case 'item/permissions/requestApproval':
      return { type: 'approve_permissions', cwd: p.cwd, reason: p.reason, permissions: p.permissions };
    case 'item/tool/requestUserInput':
      return {
        type: 'question',
        questions: (p.questions ?? []).map((q) => ({
          id: q.id,
          header: q.header,
          question: q.question,
          options: q.options?.map((o) => o.label) ?? null,
          free_text_allowed: q.isOther,
        })),
      };
  }
}

const dropNulls = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v != null));

const LEGACY_DECISIONS = {
  accept: 'approved',
  acceptForSession: 'approved_for_session',
  decline: { denied: { rejection: 'Declined by the orchestrating agent.' } },
  cancel: 'abort',
};

export class Bridge {
  threads = new Map(); // threadId → state
  requests = new Map(); // request_id → { rawId, threadId, method, params }
  listeners = new Set(); // re-evaluated on every state change
  nextRequest = 1;

  constructor({ bin, sandbox, approval, model, effort, waitSeconds = 120, rpcTimeoutMs = 60000, maxThreads = 100, env }) {
    this.defaults = { sandbox, approval, model, effort, waitSeconds };
    this.maxThreads = Math.max(1, maxThreads);
    this.app = new AppServer(
      bin,
      {
        onNotification: (m, p) => this.onNotification(m, p),
        onServerRequest: (id, m, p) => this.onServerRequest(id, m, p),
        onExit: () => this.onExit(),
      },
      { rpcTimeoutMs, env },
    );
  }

  evictSettledThreads() {
    if (this.threads.size < this.maxThreads) return;
    for (const [id, s] of this.threads) {
      if (this.threads.size < this.maxThreads) break;
      if (s.status !== 'inProgress' && !s.startingTurn && !s.loadingPromise && this.pendingFor(id).length === 0) {
        this.threads.delete(id);
      }
    }
  }

  state(threadId) {
    let s = this.threads.get(threadId);
    if (!s) {
      this.evictSettledThreads();
      s = {
        cwd: null,
        sandbox: null,
        approval: null,
        model: null,
        effort: null,
        loaded: false,
        startingTurn: false,
        loadingPromise: null,
        turnId: null,
        status: 'idle',
        error: null,
        items: [],
        active: new Map(),
        worktree: null,
        turnDiffs: new Map(), // turnId → diff string
        tokenUsage: null,
      };
      this.threads.set(threadId, s);
    }
    return s;
  }

  changed() {
    for (const l of this.listeners) l();
  }

  onNotification(method, p) {
    switch (method) {
      case 'turn/started': {
        const s = this.state(p.threadId);
        const turnId = p.turn.id;
        s.turnId = turnId;
        s.status = 'inProgress';
        s.error = null;
        s.active.clear();
        s.items = s.items.filter((i) => i.turnId === turnId);
        for (const tid of [...s.turnDiffs.keys()]) {
          if (tid !== turnId) s.turnDiffs.delete(tid);
        }
        break;
      }
      case 'item/started': {
        const d = describeActive(p.item);
        if (d) this.state(p.threadId).active.set(p.item.id, d);
        break;
      }
      case 'item/completed': {
        const s = this.state(p.threadId);
        s.active.delete(p.item.id);
        const sum = summarizeItem(p.item);
        if (sum) s.items.push({ turnId: p.turnId, ...sum });
        break;
      }
      case 'turn/diff/updated': {
        const s = this.state(p.threadId);
        if (p.turnId && typeof p.diff === 'string') {
          const { text, truncated } = truncateUtf8(p.diff, MAX_TURN_DIFF_PAYLOAD_BYTES);
          s.turnDiffs.set(p.turnId, truncated ? `${text}${TRUNCATED_MARKER}` : text);
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const s = this.state(p.threadId);
        s.tokenUsage = p.tokenUsage ?? null;
        break;
      }
      case 'turn/completed': {
        const s = this.state(p.threadId);
        s.turnId = p.turn.id;
        s.status = p.turn.status;
        s.error = p.turn.error?.message ?? (p.turn.status === 'failed' ? s.error : null);
        s.active.clear();
        for (const [rid, r] of this.requests) {
          if (r.threadId === p.threadId) this.requests.delete(rid);
        }
        this.changed();
        break;
      }
      case 'serverRequest/resolved':
        for (const [rid, r] of this.requests) if (r.rawId === p.requestId) this.requests.delete(rid);
        break;
      case 'error':
        log('error notification:', JSON.stringify(p));
        if (p.threadId && p.willRetry === false) {
          const s = this.state(p.threadId);
          s.error = p.error?.message ?? p.message ?? JSON.stringify(p);
          this.changed();
        }
        break;
    }
  }

  onServerRequest(rawId, method, p) {
    const threadId = p.threadId ?? p.conversationId;
    log(`server request ${method} (thread ${threadId})`);
    if (APPROVAL_METHODS.has(method) && this.threads.get(threadId)?.approval === 'never') {
      try {
        this.app.respond(rawId, this.approvalResult(method, p, 'accept'));
      } catch (err) {
        log(`failed to respond to auto-approved request ${method} (${rawId}): ${err.message}`);
      }
      return;
    }
    if (method === 'mcpServer/elicitation/request') {
      try {
        this.app.respond(rawId, { action: 'decline', content: null, _meta: null });
      } catch (err) {
        log(`failed to respond to elicitation request (${rawId}): ${err.message}`);
      }
      return;
    }
    const summary = summarizeRequest(method, p);
    if (!summary) {
      try {
        this.app.respondError(rawId, `codex-antigravity-plugin does not handle ${method}`);
      } catch (err) {
        log(`failed to respondError for ${method} (${rawId}): ${err.message}`);
      }
      return;
    }
    const request_id = `req_${this.nextRequest++}`;
    this.requests.set(request_id, { rawId, threadId, method, params: p, summary });
    this.changed();
  }

  approvalResult(method, p, decision) {
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return { decision };
      case 'execCommandApproval':
      case 'applyPatchApproval':
        return { decision: LEGACY_DECISIONS[decision] };
      case 'item/permissions/requestApproval':
        return decision.startsWith('accept')
          ? { permissions: dropNulls(p.permissions), scope: decision === 'acceptForSession' ? 'session' : 'turn' }
          : { permissions: {}, scope: 'turn' };
    }
  }

  onExit() {
    const threadsWithPending = new Set();
    for (const r of this.requests.values()) {
      if (r.threadId) threadsWithPending.add(r.threadId);
    }
    for (const [id, s] of this.threads) {
      const hadPending = threadsWithPending.has(id);
      if (s.status === 'inProgress' || s.startingTurn || hadPending) {
        s.status = 'failed';
        s.error = hadPending
          ? 'codex app-server exited while awaiting input'
          : 'codex app-server exited mid-turn';
      }
      s.active.clear();
      s.startingTurn = false;
      s.loadingPromise = null;
      // keep reports readable, but force thread/resume on next use (new app-server process)
      s.loaded = false;
    }
    this.requests.clear();
    this.changed();
  }

  pendingFor(threadId) {
    return [...this.requests].filter(([, r]) => r.threadId === threadId).map(([request_id, r]) => ({ request_id, ...r.summary }));
  }

  // Resolve when every (mode 'all') or any (mode 'any') thread has finished its turn or is waiting
  // on a request — or after `seconds`.
  wait(threadIds, seconds, mode = 'all') {
    const settled = (id) => this.threads.get(id).status !== 'inProgress' || this.pendingFor(id).length > 0;
    const done = () => (mode === 'all' ? threadIds.every(settled) : threadIds.some(settled));
    if (done() || seconds <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(t);
        this.listeners.delete(check);
        resolve();
      };
      const check = () => done() && finish();
      const t = setTimeout(finish, seconds * 1000);
      this.listeners.add(check);
    });
  }

  report(threadId) {
    const s = this.threads.get(threadId);
    const items = s.items.filter((i) => i.turnId === s.turnId);
    const messages = items.filter((i) => i.kind === 'message').map((i) => i.text);
    const files = new Map();
    for (const i of items) if (i.kind === 'files') for (const c of i.changes) files.set(c.path, c.type);
    const turnDiff = s.turnDiffs.get(s.turnId) ?? '';
    for (const p of parseDiffFiles(turnDiff)) {
      if (!files.has(p)) files.set(p, 'modified');
    }
    const commands = items.filter((i) => i.kind === 'command');
    const review = items.findLast((i) => i.kind === 'review');
    const pending = this.pendingFor(threadId);
    const out = {
      thread_id: threadId,
      turn_id: s.turnId,
      status: pending.length ? 'waitingForInput' : s.status,
      ...(s.model && { model: s.model }),
      ...(s.error && { error: s.error }),
      ...(s.worktree && { worktree: s.worktree }),
      ...(review && { review: review.text }),
      latest_message: review && messages.at(-1) === review.text ? undefined : messages.at(-1) ?? null,
      earlier_messages: messages.slice(0, -1),
      files_changed: [...files].map(([path, type]) => ({ path, type })),
      commands_run: commands.length,
      recent_commands: commands.slice(-8).map((c) => ({ command: c.command, exitCode: c.exitCode })),
      other_tool_calls: items.filter((i) => i.kind === 'tool').map((i) => i.name),
    };
    if (turnDiff) {
      const { text: previewText, truncated: previewTruncated } = truncateUtf8(turnDiff, 4000);
      out.diff_preview = previewTruncated ? `${previewText}${TRUNCATED_MARKER}` : previewText;
    }
    if (s.tokenUsage?.last) {
      const last = s.tokenUsage.last;
      const input = last.inputTokens ?? 0;
      const cached = last.cachedInputTokens ?? 0;
      out.token_usage = {
        input,
        cached,
        ...(last.cacheWriteInputTokens != null && { cache_write: last.cacheWriteInputTokens }),
        output: last.outputTokens ?? 0,
        ...(last.reasoningOutputTokens ? { reasoning: last.reasoningOutputTokens } : {}),
        ...(input > 0 && { cache_hit_rate: Math.round((cached / input) * 1000) / 10 }),
      };
    }
    if (s.status === 'inProgress') out.current_activity = [...s.active.values()];
    if (pending.length) {
      out.pending_requests = pending;
      out.hint = 'Codex is blocked on these requests — answer each with codex_respond, then codex_wait.';
    } else if (s.status === 'inProgress') {
      out.hint = 'Turn still running — call codex_wait to keep waiting, or codex_steer to add instructions.';
    }
    return out;
  }

  // ---------- operations ----------

  async startThread({ cwd, sandbox, approval, web_search, worktree, model, effort, ephemeral = false }) {
    assertValidCwd(cwd);
    sandbox ??= this.defaults.sandbox;
    approval ??= this.defaults.approval;
    const resolvedModel = model ?? this.defaults.model;
    const resolvedEffort = effort ?? this.defaults.effort;
    let wt = null;
    if (worktree) {
      wt = createWorktree(cwd);
      cwd = wt.cwd;
    }
    const config = { notify: [] }; // don't fire desktop-app notifiers for bridge-driven turns
    if (web_search) config.web_search = 'live';
    if (resolvedModel) config.model = resolvedModel;
    if (resolvedEffort) config.model_reasoning_effort = resolvedEffort;
    let res;
    try {
      res = await this.app.call('thread/start', {
        cwd,
        sandbox,
        approvalPolicy: approval,
        ...(resolvedModel && { model: resolvedModel }),
        config,
        ephemeral,
        serviceName: 'codex-antigravity-plugin',
      });
    } catch (err) {
      if (wt) {
        try {
          removeWorktree(wt.path, { force: true, deleteBranch: true });
        } catch (cleanupErr) {
          log(`failed to roll back worktree ${wt.path}: ${cleanupErr.message}`);
          try {
            err.message = `${err.message} (worktree rollback failed: ${cleanupErr.message})`;
          } catch {}
        }
      }
      throw err;
    }
    const s = this.state(res.thread.id);
    // Refresh insertion order without wiping any notifications that arrived before thread/start resolved.
    this.threads.delete(res.thread.id);
    this.threads.set(res.thread.id, s);
    Object.assign(s, {
      cwd: res.cwd ?? cwd,
      sandbox,
      approval,
      model: res.model ?? resolvedModel ?? null,
      effort: resolvedEffort ?? null,
      loaded: true,
      worktree: wt && { path: wt.path, cwd: wt.cwd, branch: wt.branch, base_head: wt.baseHead, parent_dirty: wt.parentDirty },
    });
    return res.thread.id;
  }

  async ensureLoaded(threadId, { cwd, sandbox, approval, model, effort } = {}) {
    if (cwd) assertValidCwd(cwd);
    const existed = this.threads.has(threadId);
    const s = this.state(threadId);
    if (s.loaded) {
      if (sandbox && sandbox !== s.sandbox) {
        throw new Error(`thread ${threadId} is already running here; sandbox is fixed per thread — start a new thread to change it`);
      }
      return s; // approval/cwd/model/effort changes go through turn/start
    }
    if (s.loadingPromise) {
      await s.loadingPromise;
      if (sandbox && sandbox !== s.sandbox) {
        throw new Error(`thread ${threadId} is already running here; sandbox is fixed per thread — start a new thread to change it`);
      }
      return s;
    }
    // After an app-server restart, preserve the thread's own policies/model/effort rather than
    // clobbering them with bridge defaults (which would break prompt cache / reasoning continuity).
    const resolvedSandbox = sandbox ?? s.sandbox ?? this.defaults.sandbox;
    const resolvedApproval = approval ?? s.approval ?? this.defaults.approval;
    const resolvedModel = model ?? s.model ?? undefined;
    const resolvedEffort = effort ?? s.effort ?? undefined;
    const resumeCwd = cwd && !sameCwd(cwd, s.cwd) ? cwd : undefined;
    if (s.sandbox && sandbox && sandbox !== s.sandbox) {
      throw new Error(`thread ${threadId} is already running here; sandbox is fixed per thread — start a new thread to change it`);
    }
    const resumeConfig = resolvedEffort ? { model_reasoning_effort: resolvedEffort } : undefined;
    s.loadingPromise = this.app
      .call('thread/resume', {
        threadId,
        sandbox: resolvedSandbox,
        approvalPolicy: resolvedApproval,
        excludeTurns: true,
        ...(resolvedModel && { model: resolvedModel }),
        ...(resumeConfig && { config: resumeConfig }),
        ...(resumeCwd && { cwd: resumeCwd }),
      })
      .then((res) =>
        Object.assign(s, {
          cwd: res?.cwd ?? resumeCwd ?? s.cwd,
          sandbox: resolvedSandbox,
          approval: resolvedApproval,
          model: res?.model ?? resolvedModel ?? s.model,
          effort: resolvedEffort ?? s.effort,
          loaded: true,
        }),
      )
      .catch((err) => {
        if (!existed && s.turnId === null && s.status === 'idle') {
          this.threads.delete(threadId);
        }
        throw err;
      })
      .finally(() => {
        s.loadingPromise = null;
      });
    return s.loadingPromise;
  }

  async startTurn(threadId, { prompt, images, model, effort, cwd, approval, output_schema }) {
    if (cwd) assertValidCwd(cwd);
    const s = this.threads.get(threadId);
    if (!s) {
      throw new Error(`thread ${threadId} is not loaded in this bridge session`);
    }
    if (s.status === 'inProgress' || s.startingTurn) {
      throw new Error(`thread ${threadId} already has a running turn — use codex_steer to add instructions, or codex_wait / codex_interrupt`);
    }
    // Avoid sending redundant overrides when unchanged (preserves WebSocket continuation & GPT-6.2 prompt cache),
    // and never clobber an existing thread's model/effort with bridge defaults on follow-up turns.
    const nextModel = model && model !== s.model ? model : undefined;
    const nextEffort = effort && effort !== s.effort ? effort : undefined;
    const nextCwd = cwd && !sameCwd(cwd, s.cwd) ? cwd : undefined;
    const nextApproval = approval && approval !== s.approval ? approval : undefined;
    // switch the local policy first: an approval request can arrive before the turn/start response
    const previousApproval = s.approval;
    s.startingTurn = true;
    if (nextApproval) s.approval = nextApproval;
    const input = [{ type: 'text', text: prompt, text_elements: [] }];
    for (const path of images ?? []) {
      input.push({ type: 'localImage', path });
    }
    try {
      const res = await this.app.call('turn/start', {
        threadId,
        input,
        ...(nextModel && { model: nextModel }),
        ...(nextEffort && { effort: nextEffort }),
        ...(nextCwd && { cwd: nextCwd }),
        ...(nextApproval && { approvalPolicy: nextApproval }),
        ...(output_schema && { outputSchema: output_schema }),
      });
      if (nextModel) s.model = nextModel;
      if (nextEffort) s.effort = nextEffort;
      if (nextCwd) s.cwd = nextCwd;
      this.noteTurn(s, res.turn);
    } catch (e) {
      s.approval = previousApproval;
      throw e;
    } finally {
      s.startingTurn = false;
    }
  }

  noteTurn(s, turn) {
    // turn/started (or even turn/completed) may have arrived before the response
    if (s.turnId !== turn.id) {
      s.turnId = turn.id;
      s.status = turn.status;
    }
  }

  async steer(threadId, prompt) {
    const s = this.threads.get(threadId);
    if (!s || s.status !== 'inProgress') throw new Error(`thread ${threadId} has no running turn — use codex_run with thread_id to send a new instruction`);
    await this.app.call('turn/steer', {
      threadId,
      expectedTurnId: s.turnId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    });
  }

  async interrupt(threadId) {
    const s = this.threads.get(threadId);
    if (!s || s.status !== 'inProgress') throw new Error(`thread ${threadId} has no running turn`);
    await this.app.call('turn/interrupt', { threadId, turnId: s.turnId });
  }

  async review({ cwd, target = 'uncommitted', base_branch, commit_sha, focus, adversarial, model, effort }) {
    assertValidCwd(cwd);
    const scope = {
      uncommitted: { type: 'uncommittedChanges' },
      base: { type: 'baseBranch', branch: base_branch },
      commit: { type: 'commit', sha: commit_sha, title: null },
    }[target];
    if (!scope) throw new Error(`invalid review target "${target}"; expected uncommitted | base | commit`);
    if (target === 'base' && !base_branch) throw new Error('target "base" needs base_branch');
    if (target === 'commit' && !commit_sha) throw new Error('target "commit" needs commit_sha');

    let reviewTarget = scope;
    if (focus || adversarial) {
      const what = {
        uncommitted: 'the uncommitted changes in this repository (staged, unstaged and untracked)',
        base: `the changes on the current branch compared to ${base_branch} (git diff ${base_branch}...HEAD)`,
        commit: `the changes introduced by commit ${commit_sha}`,
      }[target];
      reviewTarget = {
        type: 'custom',
        instructions: [`Review ${what}.`, adversarial && ADVERSARIAL_PREAMBLE, focus && `Focus on: ${focus}`].filter(Boolean).join(' '),
      };
    }

    // review/start takes no model/effort, so set them on the review thread's config
    const threadId = await this.startThread({
      cwd,
      sandbox: 'read-only',
      approval: 'never',
      model: model ?? this.defaults.model,
      effort: effort ?? this.defaults.effort,
    });
    const s = this.threads.get(threadId);
    try {
      const res = await this.app.call('review/start', { threadId, target: reviewTarget, delivery: 'inline' });
      this.noteTurn(s, res.turn);
      return threadId;
    } catch (err) {
      if (s) {
        s.status = 'failed';
        s.error = err.message;
        s.active.clear();
      }
      this.changed();
      throw err;
    }
  }

  async respond(request_id, { decision, answers }) {
    const r = this.requests.get(request_id);
    if (!r) throw new Error(`no pending request ${request_id} (already answered, or Codex withdrew it)`);
    let result;
    if (r.method === 'item/tool/requestUserInput') {
      if (!answers) throw new Error('this request is a question — pass answers: { <question id>: "answer" | ["answer", ...] }');
      result = {
        answers: Object.fromEntries(Object.entries(answers).map(([qid, a]) => [qid, { answers: Array.isArray(a) ? a : [a] }])),
      };
    } else {
      if (!decision) throw new Error('this request is an approval — pass decision: accept | acceptForSession | decline | cancel');
      result = this.approvalResult(r.method, r.params, decision);
    }
    this.requests.delete(request_id);
    this.app.respond(r.rawId, result);
    return r.threadId;
  }

  async compact(threadId) {
    await this.ensureLoaded(threadId);
    await this.app.call('thread/compact/start', { threadId });
  }

  async models(includeHidden) {
    const res = await this.app.call('model/list', { includeHidden: includeHidden ?? false });
    return res.data.map((m) => ({
      id: m.id,
      name: m.displayName,
      description: m.description,
      default: m.isDefault,
      default_effort: m.defaultReasoningEffort,
      efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    }));
  }

  async listThreads({ cwd, limit }) {
    const res = await this.app.call('thread/list', { limit, ...(cwd && { cwd }), useStateDbOnly: true });
    return res.data.map((t) => ({
      thread_id: t.id,
      name: t.name,
      preview: t.preview?.slice(0, 160),
      cwd: t.cwd,
      model: t.model,
      updatedAt: t.updatedAt && new Date(t.updatedAt * 1000).toISOString(),
      running_here: this.threads.get(t.id)?.status === 'inProgress',
    }));
  }

  close() {
    return this.app.close();
  }
}
