// Isolated git worktree management for Codex tasks.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

export const WORKTREE_ROOT = join(homedir(), '.codex-mcp', 'worktrees');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trimEnd();
}

function assertGitDir(cwd) {
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`directory does not exist: ${cwd}`);
  }
  const realCwd = realpathSync(cwd);
  try {
    const root = realpathSync(git(realCwd, 'rev-parse', '--show-toplevel').trim());
    return { root, realCwd };
  } catch {
    throw new Error(`not inside a git repository: ${cwd}`);
  }
}

export function createWorktree(cwd) {
  const { root, realCwd } = assertGitDir(cwd);
  try {
    git(root, 'rev-parse', '--verify', 'HEAD');
  } catch {
    throw new Error(`git repository at ${root} has no commits yet (unborn HEAD); create an initial commit or run with worktree: false`);
  }

  const parentDirty = git(root, 'status', '--porcelain').length > 0;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6);
  const branch = `codex/${stamp}`;
  const dir = join(WORKTREE_ROOT, `${basename(root)}-${stamp}`);
  mkdirSync(WORKTREE_ROOT, { recursive: true });
  git(root, 'worktree', 'add', '-b', branch, dir, 'HEAD');
  const rel = relative(root, realCwd);
  if (rel.startsWith('..')) {
    throw new Error(`resolved cwd ${realCwd} escapes repository root ${root}`);
  }
  const wtCwd = rel ? join(dir, rel) : dir;
  if (!existsSync(wtCwd)) {
    mkdirSync(wtCwd, { recursive: true });
  }
  return {
    path: dir,
    branch,
    cwd: wtCwd,
    repoRoot: root,
    parentDirty,
  };
}

export function listWorktrees(cwd) {
  if (cwd) {
    const { root } = assertGitDir(cwd);
    const raw = git(root, 'worktree', 'list', '--porcelain');
    const entries = [];
    let current = {};
    for (const line of [...raw.split('\n'), '']) {
      if (!line.trim()) {
        if (current.path) entries.push(current);
        current = {};
        continue;
      }
      if (line.startsWith('worktree ')) current.path = line.slice(9);
      else if (line.startsWith('HEAD ')) current.head = line.slice(5);
      else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'detached') current.detached = true;
    }
    return entries
      .filter((e) => e.branch?.startsWith('codex/') || resolve(e.path).startsWith(resolve(WORKTREE_ROOT) + '/'))
      .map((e) => ({
        path: e.path,
        branch: e.branch ?? null,
        dirty: existsSync(e.path) ? git(e.path, 'status', '--porcelain').length > 0 : null,
      }));
  }

  if (!existsSync(WORKTREE_ROOT)) return [];
  return readdirSync(WORKTREE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const path = join(WORKTREE_ROOT, d.name);
      try {
        const branch = git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
        const dirty = git(path, 'status', '--porcelain').length > 0;
        return { path, branch, dirty };
      } catch {
        return { path, branch: null, dirty: null };
      }
    });
}

export function inspectWorktreeDiff(worktreePath, { maxBytes = 24000 } = {}) {
  const { root } = assertGitDir(worktreePath);
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const statusShort = git(root, 'status', '--short');
  const diffStat = git(root, 'diff', '--stat', 'HEAD');
  const fullDiff = git(root, 'diff', 'HEAD');
  const truncated = Buffer.byteLength(fullDiff, 'utf8') > maxBytes;
  const diff = truncated ? fullDiff.slice(0, maxBytes) + '\n... [truncated]' : fullDiff;
  return { path: root, branch, status_short: statusShort, diff_stat: diffStat, diff, truncated };
}

export function removeWorktree(worktreePath, { force = false, deleteBranch = false } = {}) {
  const resolved = resolve(worktreePath);
  if (!existsSync(resolved)) {
    throw new Error(`worktree path does not exist: ${worktreePath}`);
  }
  const branch = git(resolved, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const inManagedRoot = resolved.startsWith(resolve(WORKTREE_ROOT) + '/');
  if (!inManagedRoot && !branch.startsWith('codex/')) {
    throw new Error(`refusing to remove non-Codex worktree: ${worktreePath} (branch=${branch})`);
  }

  const dirty = git(resolved, 'status', '--porcelain').length > 0;
  if (dirty && !force) {
    throw new Error(`worktree ${worktreePath} has uncommitted changes; inspect/merge first or pass force: true`);
  }

  const commonDir = resolve(resolved, git(resolved, 'rev-parse', '--git-common-dir').trim());
  const mainRepo = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(resolved);
  git(mainRepo, ...args);

  let branchDeleted = false;
  if (deleteBranch && branch && branch.startsWith('codex/')) {
    git(mainRepo, 'branch', force ? '-D' : '-d', branch);
    branchDeleted = true;
  }

  return { removed: resolved, branch, branch_deleted: branchDeleted };
}
