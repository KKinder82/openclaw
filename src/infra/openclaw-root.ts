import path from "node:path";
import { fileURLToPath } from "node:url";
import { openClawRootFs, openClawRootFsSync } from "./openclaw-root.fs.runtime.js";

const CORE_PACKAGE_NAMES = new Set(["openclaw"]);
const packageNameCache = new Map<string, string | null>();
const packageRootCache = new Map<string, string | null>();
const argv1CandidateCache = new Map<string, string[]>();

// 根据json中有没有 name 字段来判断是否是一个有效的 package.json 文件
function parsePackageName(raw: string): string | null {
  // 根据json中有没有 name 字段来判断是否是一个有效的 package.json 文件，
  const parsed = JSON.parse(raw) as { name?: unknown };
  return typeof parsed.name === "string" ? parsed.name : null;
}

// 读取 package.json 中的 name 字段，如果读取失败或格式不正确，则返回 null。
// 使用缓存来避免重复的文件系统访问。
async function readPackageName(dir: string): Promise<string | null> {
  const packageJsonPath = path.join(path.resolve(dir), "package.json");
  if (packageNameCache.has(packageJsonPath)) {
    return packageNameCache.get(packageJsonPath) ?? null;
  }
  try {
    const name = parsePackageName(await openClawRootFs.readFile(packageJsonPath, "utf-8"));
    packageNameCache.set(packageJsonPath, name);
    return name;
  } catch {
    packageNameCache.set(packageJsonPath, null);
    return null;
  }
}

// 读取 package.json （同步版本），如果读取失败或格式不正确，则返回 null。
function readPackageNameSync(dir: string): string | null {
  const packageJsonPath = path.join(path.resolve(dir), "package.json");
  if (packageNameCache.has(packageJsonPath)) {
    return packageNameCache.get(packageJsonPath) ?? null;
  }
  try {
    const name = parsePackageName(openClawRootFsSync.readFileSync(packageJsonPath, "utf-8"));
    packageNameCache.set(packageJsonPath, name);
    return name;
  } catch {
    packageNameCache.set(packageJsonPath, null);
    return null;
  }
}

// 查找 openclaw 包的根目录，
async function findPackageRoot(startDir: string, maxDepth = 12): Promise<string | null> {
  for (const current of iterAncestorDirs(startDir, maxDepth)) {
    const name = await readPackageName(current);
    if (name && CORE_PACKAGE_NAMES.has(name)) {
      // name == openclaw，说明找到了 openclaw 包的根目录，返回当前目录的绝对路径。
      return current;
    }
  }
  return null;
}

function findPackageRootSync(startDir: string, maxDepth = 12): string | null {
  for (const current of iterAncestorDirs(startDir, maxDepth)) {
    const name = readPackageNameSync(current);
    if (name && CORE_PACKAGE_NAMES.has(name)) {
      return current;
    }
  }
  return null;
}

// 向祖先目录迭代，生成器函数，
// 接受一个起始目录和最大深度，依次返回每个祖先目录的绝对路径，直到达到根目录或最大深度为止。
function* iterAncestorDirs(startDir: string, maxDepth: number): Generator<string> {
  let current = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i += 1) {
    yield current;
    const parent = path.dirname(current);
    if (parent === current) {
      // 到根目录，停止迭代。
      break;
    }
    current = parent;
  }
}

// 根据 Argv1 生成候选目录列表，
// Argv1 ：cacheKey | 目录
function candidateDirsFromArgv1(argv1: string): string[] {
  const cacheKey = path.resolve(argv1);
  const cached = argv1CandidateCache.get(cacheKey);
  if (cached) {
    // 如果已经缓存了从 argv1 解析出的候选目录，直接返回缓存的值。
    return [...cached];
  }
  const normalized = path.resolve(argv1);
  const candidates = [path.dirname(normalized)];

  // Resolve symlinks for version managers (nvm, fnm, n, Homebrew/Linuxbrew)
  // that create symlinks in bin/ pointing to the real package location.
  try {
    const resolved = openClawRootFsSync.realpathSync(normalized);
    if (resolved !== normalized) {
      candidates.push(path.dirname(resolved));
    }
  } catch {
    // realpathSync throws if path doesn't exist; keep original candidates
  }

  const parts = normalized.split(path.sep);
  const binIndex = parts.lastIndexOf(".bin");
  if (binIndex > 0 && parts[binIndex - 1] === "node_modules") {
    const binName = path.basename(normalized);
    const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
    candidates.push(path.join(nodeModulesDir, binName));
  }
  const deduped = dedupeCandidates(candidates);
  argv1CandidateCache.set(cacheKey, deduped);
  return [...deduped];
}

export async function resolveOpenClawPackageRoot(opts: {
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
}): Promise<string | null> {
  // 构建候选目录列表，
  const candidates = buildCandidates(opts);
  const cacheKey = createPackageRootCacheKey(candidates);
  if (packageRootCache.has(cacheKey)) {
    return packageRootCache.get(cacheKey) ?? null;
  }
  for (const candidate of candidates) {
    const found = await findPackageRoot(candidate);
    if (found) {
      packageRootCache.set(cacheKey, found);
      return found;
    }
  }

  packageRootCache.set(cacheKey, null);
  return null;
}

export function resolveOpenClawPackageRootSync(opts: {
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
}): string | null {
  const candidates = buildCandidates(opts);
  const cacheKey = createPackageRootCacheKey(candidates);
  if (packageRootCache.has(cacheKey)) {
    return packageRootCache.get(cacheKey) ?? null;
  }
  for (const candidate of candidates) {
    const found = findPackageRootSync(candidate);
    if (found) {
      packageRootCache.set(cacheKey, found);
      return found;
    }
  }

  packageRootCache.set(cacheKey, null);
  return null;
}

function buildCandidates(opts: { cwd?: string; argv1?: string; moduleUrl?: string }): string[] {
  const candidates: string[] = [];

  if (opts.moduleUrl) {
    try {
      // 如果提供了 moduleUrl，尝试将其解析为文件路径并添加到候选列表中，
      candidates.push(path.dirname(fileURLToPath(opts.moduleUrl)));
    } catch {
      // Ignore invalid file:// URLs and keep other package-root hints.
    }
  }
  if (opts.argv1) {
    candidates.push(...candidateDirsFromArgv1(opts.argv1));
  }
  if (opts.cwd) {
    // 如果提供了 cwd，添加到候选列表中，
    candidates.push(opts.cwd);
  }
  // 对候选目录列表进行去重，确保每个目录只出现一次，避免重复的文件系统访问。
  return dedupeCandidates(candidates);
}

// 对候选目录列表进行去重，确保每个目录只出现一次，避免重复的文件系统访问。
function dedupeCandidates(candidates: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    deduped.push(resolved);
  }
  return deduped;
}

function createPackageRootCacheKey(candidates: readonly string[]): string {
  return candidates.join("\0");
}

export const __testing = {
  clearOpenClawPackageRootCaches(): void {
    packageNameCache.clear();
    packageRootCache.clear();
    argv1CandidateCache.clear();
  },
};
