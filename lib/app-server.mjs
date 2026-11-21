// Resilient client for `codex app-server` over stdio (newline-delimited JSON, no `jsonrpc` field).
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export const log = (...a) => console.error('[codex-mcp]', ...a);

function isExecutable(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveCodexBin(preferred = 'codex') {
  if (!preferred || preferred === 'codex') {
    const pathEntries = (process.env.PATH || '').split(delimiter).filter(Boolean);
    const home = homedir();
    const fallbackEntries = [
      dirname(process.execPath),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      join(home, '.local', 'bin'),
      join(home, '.npm-global', 'bin'),
      join(home, '.volta', 'bin'),
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS',
    ];
    for (const dir of [...pathEntries, ...fallbackEntries]) {
      const candidate = join(dir, 'codex');
      if (existsSync(candidate) && isExecutable(candidate)) return candidate;
    }
    return 'codex';
  }
  return preferred;
}

export function buildChildEnv(bin, baseEnv = process.env) {
  const existing = (baseEnv.PATH || '').split(delimiter).filter(Boolean);
  const extra = [dirname(process.execPath)];
  if (bin.includes('/')) extra.push(dirname(bin));
  extra.push('/opt/homebrew/bin', '/usr/local/bin');

  const merged = [];
  const seen = new Set();
  for (const dir of [...extra, ...existing]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }
  return { ...baseEnv, PATH: merged.join(delimiter) };
}

export class AppServer {
  proc = null;
  nextId = 1;
  pending = new Map();
  ready = null;
  closing = false;

  // handlers: { onNotification(method, params), onServerRequest(id, method, params), onExit() }
  constructor(bin, handlers) {
    this.bin = resolveCodexBin(bin);
    this.handlers = handlers;
  }

  start() {
    if (this.ready) return this.ready;
    this.closing = false;
    const proc = spawn(this.bin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildChildEnv(this.bin),
    });
    this.proc = proc;
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          this.handle(JSON.parse(line));
        } catch (err) {
          log(`ignoring non-JSON stdout line from codex app-server: ${err.message}`);
        }
      }
    });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    proc.on('error', (err) => {
      log(`failed to spawn ${this.bin}: ${err.message}`);
      for (const { reject } of this.pending.values()) {
        reject(new Error(`failed to spawn codex app-server (${this.bin}): ${err.message}`));
      }
      this.pending.clear();
      this.proc = null;
      this.ready = null;
      this.handlers.onExit();
    });
    proc.on('exit', (code, sig) => {
      if (!this.closing) {
        log(`app-server exited code=${code} sig=${sig}; will respawn on next call`);
      }
      for (const { reject } of this.pending.values()) reject(new Error('codex app-server exited'));
      this.pending.clear();
      this.proc = null;
      this.ready = null;
      this.handlers.onExit();
    });
    this.ready = this.request('initialize', {
      clientInfo: { name: 'codex-antigravity-plugin', title: 'Codex Antigravity MCP bridge', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
      .then(() => this.send({ method: 'initialized' }))
      .catch((err) => {
        this.ready = null;
        throw err;
      });
    return this.ready;
  }

  send(msg) {
    if (!this.proc?.stdin?.writable) {
      throw new Error('codex app-server stdin is not writable');
    }
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.send({ id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async call(method, params) {
    await this.start();
    return this.request(method, params);
  }

  respond(id, result) {
    this.send({ id, result });
  }

  respondError(id, message) {
    this.send({ id, error: { code: -32601, message } });
  }

  async close() {
    this.closing = true;
    const proc = this.proc;
    if (!proc) return;
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
        resolve();
      }, 1500);
      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        proc.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });
  }

  handle(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined) {
      this.handlers.onServerRequest(msg.id, msg.method, msg.params ?? {});
    } else {
      this.handlers.onNotification(msg.method, msg.params ?? {});
    }
  }
}
