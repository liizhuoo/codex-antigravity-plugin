#!/usr/bin/env node
// Offline stand-in for `codex app-server`. Behaviour is driven by the prompt:
//   "echo <text>"  reply with <text>
//   "shell-edit"   emit a turn/diff/updated notification without a fileChange item
//   "check-image"  echo any localImage paths passed in turn/start input
//   "approve"      ask for command approval, then run (or not) depending on the answer
//   "ask"          ask a question, then echo the answer
//   "slow"         keep the turn running until steered (finishes with the steer text) or interrupted
//   "crash"        exit the process mid-turn
//   "approve-early" like approve, but the request is sent before the turn/start response
//   "policy"       reply with the sandbox this thread was started/resumed with
//   "delay-turn-start" hold the turn/start RPC response briefly to test concurrency
//   "error-fatal"  emit a non-retried error notification then fail the turn
//   "bad-json-then-ok" emit a non-JSON stdout line then reply normally
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

if (process.argv[2] !== 'app-server') process.exit(2);

const HANG = Symbol('HANG');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let buf = '';
let nextId = 1000;
let threadSeq = 0;
const waitingOn = new Map(); // server request id → callback(result)
const turns = new Map(); // threadId → { id, onSteer }
const sandboxes = new Map(); // threadId → sandbox from thread/start or thread/resume

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const notify = (method, params) => send({ method, params });
const ask = (method, params, cb) => {
  const id = nextId++;
  waitingOn.set(id, cb);
  send({ id, method, params });
};

const turn = (id, status = 'inProgress') => ({ id, items: [], status, error: null });
let itemSeq = 0;
function item(threadId, turnId, it) {
  it.id = `item_${itemSeq++}`;
  notify('item/started', { threadId, turnId, item: it, startedAtMs: 0 });
  notify('item/completed', { threadId, turnId, item: it, completedAtMs: 0 });
}
const message = (threadId, turnId, text) => item(threadId, turnId, { type: 'agentMessage', text });
function complete(threadId, turnId, status = 'completed') {
  turns.delete(threadId);
  notify('turn/completed', { threadId, turn: turn(turnId, status) });
}

function startTurn(threadId, input) {
  const text = input[0].text;
  const turnId = `turn_${process.pid}_${itemSeq++}`;
  setImmediate(() => {
    notify('turn/started', { threadId, turn: turn(turnId) });
    if (text.startsWith('echo ')) {
      message(threadId, turnId, text.slice(5));
      complete(threadId, turnId);
    } else if (text === 'shell-edit') {
      item(threadId, turnId, { type: 'commandExecution', command: 'python3 fix.py', exitCode: 0, status: 'completed' });
      notify('turn/diff/updated', {
        threadId,
        turnId,
        diff: 'diff --git a/src/app.js b/src/app.js\n--- a/src/app.js\n+++ b/src/app.js\n@@ -1 +1 @@\n-old\n+new\n',
      });
      notify('thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: {
          total: { totalTokens: 150, inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 10 },
          last: { totalTokens: 150, inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 10 },
          modelContextWindow: 200000,
        },
      });
      message(threadId, turnId, 'updated via shell');
      complete(threadId, turnId);
    } else if (text === 'check-image') {
      const imgs = input.filter((i) => i.type === 'localImage').map((i) => i.path);
      message(threadId, turnId, `images=${imgs.join(',')}`);
      complete(threadId, turnId);
    } else if (text === 'approve') {
      ask('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'x', command: 'rm -rf build', cwd: '/tmp', startedAtMs: 0 }, ({ decision }) => {
        if (decision === 'accept') item(threadId, turnId, { type: 'commandExecution', command: 'rm -rf build', exitCode: 0, status: 'completed' });
        message(threadId, turnId, `decision=${decision}`);
        complete(threadId, turnId);
      });
    } else if (text === 'ask') {
      const questions = [{ id: 'color', header: 'Color', question: 'Which color?', isOther: true, isSecret: false, options: [{ label: 'red', description: '' }] }];
      ask('item/tool/requestUserInput', { threadId, turnId, itemId: 'q', questions, isBlocking: true }, ({ answers }) => {
        message(threadId, turnId, `answer=${answers.color.answers.join(',')}`);
        complete(threadId, turnId);
      });
    } else if (text === 'slow') {
      item(threadId, turnId, { type: 'commandExecution', command: 'sleep 999', exitCode: null, status: 'inProgress' });
      notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'live', command: 'make build' }, startedAtMs: 0 });
      turns.get(threadId).onSteer = (t) => {
        message(threadId, turnId, `steered=${t}`);
        complete(threadId, turnId);
      };
    } else if (text === 'policy') {
      message(threadId, turnId, `sandbox=${sandboxes.get(threadId)}`);
      complete(threadId, turnId);
    } else if (text === 'error-fatal') {
      notify('error', { threadId, willRetry: false, error: { message: 'fatal upstream error' } });
      complete(threadId, turnId, 'failed');
    } else if (text === 'bad-json-then-ok') {
      process.stdout.write('not-valid-json-noise\n');
      message(threadId, turnId, 'survived-noise');
      complete(threadId, turnId);
    } else if (text === 'crash') {
      process.exit(1);
    }
  });
  turns.set(threadId, { id: turnId });
  return turnId;
}

const handlers = {
  initialize: () => {
    const hangOnce = process.env.CODEX_FAKE_HANG_ONCE_FILE;
    if (hangOnce && existsSync(hangOnce)) {
      rmSync(hangOnce, { force: true });
      setInterval(() => {}, 10000);
      return HANG;
    }
    if (process.env.CODEX_FAKE_HANG_INIT === '1') {
      setInterval(() => {}, 10000);
      return HANG;
    }
    return { userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' };
  },
  'thread/start': (p) => {
    if (process.env.CODEX_FAKE_FAIL_THREAD_START === '1' || (p.cwd && existsSync(join(p.cwd, '.fail-thread-start')))) {
      throw new Error('simulated thread/start failure');
    }
    const id = `thread_${process.pid}_${threadSeq++}`;
    sandboxes.set(id, p.sandbox);
    return { thread: { id }, cwd: p.cwd, model: 'fake-model', sandbox: p.sandbox, approvalPolicy: p.approvalPolicy };
  },
  'thread/resume': async (p) => {
    if (process.env.CODEX_FAKE_LOG_FILE) {
      appendFileSync(process.env.CODEX_FAKE_LOG_FILE, 'thread/resume\n');
    }
    const resumeDelay = Number(process.env.CODEX_FAKE_RESUME_DELAY_MS || 0);
    if (resumeDelay > 0) await delay(resumeDelay);
    sandboxes.set(p.threadId, p.sandbox);
    return { thread: { id: p.threadId } };
  },
  'turn/start': (p) => {
    const text = p.input[0].text;
    if (text === 'delay-turn-start') {
      const turnId = `turn_${process.pid}_${itemSeq++}`;
      turns.set(p.threadId, { id: turnId });
      return delay(150).then(() => {
        setImmediate(() => {
          notify('turn/started', { threadId: p.threadId, turn: turn(turnId) });
          message(p.threadId, turnId, 'delayed-ok');
          complete(p.threadId, turnId);
        });
        return { turn: turn(turnId) };
      });
    }
    if (text !== 'approve-early') return { turn: turn(startTurn(p.threadId, p.input)) };
    const turnId = `turn_${process.pid}_${itemSeq++}`;
    turns.set(p.threadId, { id: turnId });
    ask('item/commandExecution/requestApproval', { threadId: p.threadId, turnId, itemId: 'x', command: 'curl evil', cwd: '/tmp', startedAtMs: 0 }, ({ decision }) => {
      message(p.threadId, turnId, `decision=${decision}`);
      complete(p.threadId, turnId);
    });
    setImmediate(() => notify('turn/started', { threadId: p.threadId, turn: turn(turnId) }));
    return { turn: turn(turnId) };
  },
  'turn/steer': (p) => {
    const t = turns.get(p.threadId);
    if (!t || t.id !== p.expectedTurnId) throw new Error('expectedTurnId mismatch');
    setImmediate(() => t.onSteer(p.input[0].text));
    return { turnId: t.id };
  },
  'turn/interrupt': (p) => {
    setImmediate(() => complete(p.threadId, p.turnId, 'interrupted'));
    return {};
  },
  'review/start': (p) => {
    if (
      process.env.CODEX_FAKE_FAIL_REVIEW_START === '1' ||
      (typeof p.target?.instructions === 'string' && p.target.instructions.includes('fail-review-start'))
    ) {
      throw new Error('simulated review/start failure');
    }
    const turnId = `turn_${process.pid}_${itemSeq++}`;
    setImmediate(() => {
      notify('turn/started', { threadId: p.threadId, turn: turn(turnId) });
      item(p.threadId, turnId, { type: 'exitedReviewMode', review: `REVIEW ${JSON.stringify(p.target)}` });
      complete(p.threadId, turnId);
    });
    return { turn: turn(turnId), reviewThreadId: p.threadId };
  },
  'thread/compact/start': () => ({}),
  'model/list': () => {
    if (process.env.CODEX_FAKE_HANG_METHOD === 'model/list') {
      setInterval(() => {}, 10000);
      return HANG;
    }
    return {
      data: [{ id: 'fake-model', displayName: 'Fake', description: 'd', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }],
      nextCursor: null,
    };
  },
  'thread/list': () => ({ data: [{ id: 'thread_0', name: null, preview: 'hi', cwd: '/tmp', model: 'fake-model', updatedAt: 0 }], nextCursor: null }),
};

process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.method === undefined) {
      waitingOn.get(msg.id)(msg.result);
      waitingOn.delete(msg.id);
      notify('serverRequest/resolved', { threadId: null, requestId: msg.id });
    } else if (msg.id !== undefined) {
      try {
        const res = handlers[msg.method](msg.params);
        if (res === HANG) continue;
        if (res && typeof res.then === 'function') {
          res.then(
            (val) => {
              if (val !== HANG) send({ id: msg.id, result: val });
            },
            (e) => send({ id: msg.id, error: { code: -1, message: e.message } }),
          );
        } else {
          send({ id: msg.id, result: res });
        }
      } catch (e) {
        send({ id: msg.id, error: { code: -1, message: e.message } });
      }
    }
  }
});
