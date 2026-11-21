// Isolated git worktree management for Codex tasks.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export const WORKTREE_ROOT = join(homedir(), '.codex-mcp', 'worktrees');
export const WORKTREE_META_ROOT = join(homedir(), '.codex-mcp', 'meta');

export function truncateUtf8(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) {
    return { text: str, truncated: false };
  }
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

function metaPathFor(worktreeDir) {
  return join(WORKTREE_META_ROOT, `${basename(worktreeDir)}.json`);
}

function readMatchingMeta(worktreeRoot) {
  const metaFile = metaPathFor(worktreeRoot);
  if (!existsSync(metaFile)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    if (!meta || typeof meta !== 'object' || !meta.path) return null;
    const canonMetaPath = existsSync(meta.path) ? realpathSync(meta.path) : resolve(meta.path);
    return canonMetaPath === worktreeRoot ? meta : null;
  } catch {
    return null;
  }
}

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
  let baseHead;
  try {
    baseHead = git(root, 'rev-parse', '--verify', 'HEAD').trim();
  } catch {
    throw new Error(`git repository at ${root} has no commits yet (unborn HEAD); create an initial commit or run with worktree: false`);
  }

  const parentDirty = git(root, 'status', '--porcelain').length > 0;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6);
  const branch = `codex/${stamp}`;
  mkdirSync(WORKTREE_ROOT, { recursive: true });
  const realManagedRoot = realpathSync(WORKTREE_ROOT);
  const dir = join(realManagedRoot, `${basename(root)}-${stamp}`);

  let added = false;
  let realDir = dir;
  try {
    git(root, 'worktree', 'add', '-b', branch, dir, 'HEAD');
    added = true;
    realDir = realpathSync(dir);
    const rel = relative(root, realCwd);
    if (rel.startsWith('..')) {
      throw new Error(`resolved cwd ${realCwd} escapes repository root ${root}`);
    }
    const wtCwd = rel ? join(realDir, rel) : realDir;
    if (!existsSync(wtCwd)) {
      mkdirSync(wtCwd, { recursive: true });
    }
    mkdirSync(WORKTREE_META_ROOT, { recursive: true });
    const meta = {
      path: realDir,
      branch,
      repoRoot: root,
      baseHead,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(metaPathFor(realDir), JSON.stringify(meta, null, 2) + '\n');
    return {
      path: realDir,
      branch,
      cwd: wtCwd,
      repoRoot: root,
      baseHead,
      parentDirty,
    };
  } catch (err) {
    if (added) {
      try {
        git(root, 'worktree', 'remove', '--force', realDir);
      } catch {}
      try {
        git(root, 'branch', '-D', branch);
      } catch {}
      try {
        rmSync(metaPathFor(realDir), { force: true });
      } catch {}
    }
    throw err;
  }
}

export function listWorktrees(cwd) {
  const realManagedRoot = existsSync(WORKTREE_ROOT) ? realpathSync(WORKTREE_ROOT) : resolve(WORKTREE_ROOT);
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
      .map((e) => {
        const canonPath = existsSync(e.path) ? realpathSync(e.path) : resolve(e.path);
        return { ...e, canonPath };
      })
      .filter((e) => e.canonPath.startsWith(realManagedRoot + sep) && dirname(e.canonPath) === realManagedRoot)
      .map((e) => {
        const meta = readMatchingMeta(e.canonPath);
        return {
          path: e.canonPath,
          branch: e.branch ?? null,
          dirty: existsSync(e.canonPath) ? git(e.canonPath, 'status', '--porcelain').length > 0 : null,
          ...(meta && { base_head: meta.baseHead ?? null, repo_root: meta.repoRoot ?? null }),
        };
      });
  }

  if (!existsSync(WORKTREE_ROOT)) return [];
  return readdirSync(WORKTREE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const rawPath = join(realManagedRoot, d.name);
      const path = existsSync(rawPath) ? realpathSync(rawPath) : rawPath;
      const meta = readMatchingMeta(path);
      try {
        const branch = git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
        const dirty = git(path, 'status', '--porcelain').length > 0;
        return {
          path,
          branch,
          dirty,
          ...(meta && { base_head: meta.baseHead ?? null, repo_root: meta.repoRoot ?? null }),
        };
      } catch {
        return {
          path,
          branch: null,
          dirty: null,
          ...(meta && { base_head: meta.baseHead ?? null, repo_root: meta.repoRoot ?? null }),
        };
      }
    });
}

export function inspectWorktreeDiff(worktreePath, { maxBytes = 24000 } = {}) {
  const { root } = assertGitDir(worktreePath);
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const statusShort = git(root, 'status', '--short');
  const meta = readMatchingMeta(root);
  const baseHead = meta?.baseHead ?? null;

  let diffBase = 'HEAD';
  let commitsAhead = '';
  if (baseHead) {
    const currentHead = git(root, 'rev-parse', 'HEAD').trim();
    if (currentHead !== baseHead) {
      try {
        git(root, 'cat-file', '-e', `${baseHead}^{commit}`);
        commitsAhead = git(root, 'log', '--oneline', `${baseHead}..HEAD`);
        diffBase = baseHead;
      } catch {
        // Fall back to HEAD if recorded baseHead is unavailable
      }
    }
  }

  const diffStat = git(root, 'diff', '--stat', diffBase);
  const fullDiff = git(root, 'diff', diffBase);
  const { text: sliced, truncated } = truncateUtf8(fullDiff, maxBytes);
  const diff = truncated ? `${sliced}\n... [truncated]` : sliced;
  return {
    path: root,
    branch,
    base_head: baseHead,
    commits_ahead: commitsAhead,
    status_short: statusShort,
    diff_stat: diffStat,
    diff,
    truncated,
  };
}

export function removeWorktree(worktreePath, { force = false, deleteBranch = false } = {}) {
  const { root } = assertGitDir(worktreePath);
  const realManagedRoot = existsSync(WORKTREE_ROOT) ? realpathSync(WORKTREE_ROOT) : resolve(WORKTREE_ROOT);
  const inManagedRoot = root.startsWith(realManagedRoot + sep) && dirname(root) === realManagedRoot;

  const gitDir = realpathSync(resolve(root, git(root, 'rev-parse', '--git-dir').trim()));
  const commonDir = realpathSync(resolve(root, git(root, 'rev-parse', '--git-common-dir').trim()));
  const isLinkedWorktree = gitDir !== commonDir;

  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  const meta = readMatchingMeta(root);
  const hasMetadata = Boolean(meta);

  if (!inManagedRoot || !isLinkedWorktree || (!hasMetadata && !branch.startsWith('codex/'))) {
    throw new Error(`refusing to remove non-Codex worktree: ${worktreePath} (branch=${branch})`);
  }

  const dirty = git(root, 'status', '--porcelain').length > 0;
  if (dirty && !force) {
    throw new Error(`worktree ${worktreePath} has uncommitted changes; inspect/merge first or pass force: true`);
  }

  const mainRepo = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(root);
  git(mainRepo, ...args);
  rmSync(metaPathFor(root), { force: true });

  let branchDeleted = false;
  const branchToDelete = branch !== 'HEAD' ? branch : meta?.branch;
  if (deleteBranch && branchToDelete && branchToDelete.startsWith('codex/')) {
    git(mainRepo, 'branch', force ? '-D' : '-d', branchToDelete);
    branchDeleted = true;
  }

  return { removed: root, branch, branch_deleted: branchDeleted };
}
