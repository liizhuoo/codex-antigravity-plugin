// Real end-to-end check against your locally installed Codex CLI (defaults to gpt-6-luna, effort low).
// Usage: node test/e2e.mjs <scratch dir> [--model gpt-6-luna] [--effort low] [--repo <git repo>]
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
const scratch = args[0];
if (!scratch || scratch.startsWith('--')) {
  console.error('Usage: node test/e2e.mjs <scratch dir> [--model gpt-6-luna] [--effort low] [--repo <git repo>]');
  process.exit(2);
}

const opt = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const model = opt('--model', 'gpt-6-luna');
const effort = opt('--effort', 'low');
const repo = opt('--repo', null);

const client = new Client({ name: 'e2e', version: '0.1.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../server.mjs', import.meta.url).pathname],
    stderr: 'inherit',
  }),
);

async function call(name, params) {
  const r = await client.callTool({ name, arguments: params }, undefined, { timeout: 600_000 });
  console.log(`--- ${name}${r.isError ? ' (ERROR)' : ''}\n${r.content[0].text}`);
  if (r.isError) process.exit(1);
  return JSON.parse(r.content[0].text);
}

async function settle(r) {
  while (r.status === 'inProgress') {
    r = await call('codex_wait', { thread_id: r.thread_id, wait_seconds: 90 });
  }
  return r;
}

try {
  const models = await call('codex_models', {});
  assert.ok(models.some((m) => m.id === model), `model ${model} not found in codex_models`);
  console.log(`Verified ${models.length} models; testing with model=${model}, effort=${effort}`);

  let r = await settle(
    await call('codex_run', {
      cwd: scratch,
      model,
      effort,
      wait_seconds: 90,
      prompt: 'Create note.txt containing the single word ok. Then reply with exactly: done',
    }),
  );
  if (r.status === 'waitingForInput') {
    r = await settle(
      await call('codex_respond', {
        request_id: r.pending_requests[0].request_id,
        decision: 'accept',
        wait_seconds: 90,
      }),
    );
  }
  assert.equal(r.status, 'completed');
  assert.ok(existsSync(join(scratch, 'note.txt')), 'note.txt should be created');
  assert.equal(readFileSync(join(scratch, 'note.txt'), 'utf8').trim(), 'ok');

  const r2 = await settle(
    await call('codex_run', {
      thread_id: r.thread_id,
      model,
      effort,
      wait_seconds: 90,
      prompt: 'Reply with a JSON object containing the filename you created.',
      output_schema: {
        type: 'object',
        properties: { file: { type: 'string' } },
        required: ['file'],
        additionalProperties: false,
      },
    }),
  );
  assert.equal(r2.status, 'completed');
  assert.equal(JSON.parse(r2.latest_message).file, 'note.txt');

  if (repo) {
    const rev = await settle(
      await call('codex_review', {
        cwd: repo,
        target: 'uncommitted',
        model,
        effort,
        wait_seconds: 120,
      }),
    );
    assert.equal(rev.status, 'completed');
    assert.ok(rev.review, 'review output should be non-empty');
  }
  console.log('E2E PASSED');
} finally {
  await client.close();
}
