import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBrewPathDirs } from "./brew.js";
import { isTruthyEnvValue } from "./env.js";

type EnsureOpenClawPathOpts = {
  execPath?: string;
  cwd?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  pathEnv?: string; // 当前 PATH 环境变量的值，如果提供了这个选项，则会使用它来进行 PATH 的合并，而不是直接使用 process.env.PATH。
  allowProjectLocalBin?: boolean;
};

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

// 将现有的 PATH 环境变量与要添加的路径进行合并，确保不重复，并且保持顺序。
function mergePath(params: { existing: string; prepend?: string[]; append?: string[] }): string {
  // 保证existing路径Path linux以:分隔, windows用; 分隔。
  const partsExisting = params.existing
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean); // Boolean(value) -> boolean

  //保证不是空字符串，并且去掉两端的空白字符。
  const partsPrepend = (params.prepend ?? []).map((part) => part.trim()).filter(Boolean);
  const partsAppend = (params.append ?? []).map((part) => part.trim()).filter(Boolean);

  const seen = new Set<string>();
  const merged: string[] = [];
  for (const part of [...partsPrepend, ...partsExisting, ...partsAppend]) {
    if (!seen.has(part)) {
      // 没有见过这个路径，则添加到结果中，并且标记为已见过，
      seen.add(part);
      merged.push(part);
    }
  }
  return merged.join(path.delimiter);
}

// 生成 候选的可执行文件目录列表，
function candidateBinDirs(opts: EnsureOpenClawPathOpts): { prepend: string[]; append: string[] } {
  const execPath = opts.execPath ?? process.execPath;
  const cwd = opts.cwd ?? process.cwd();
  const homeDir = opts.homeDir ?? os.homedir();
  const platform = opts.platform ?? process.platform;

  const prepend: string[] = []; //前面的
  const append: string[] = []; //后面的

  // Keep the active runtime directory ahead of PATH hardening so shebang-based
  // subprocesses keep using the same Node/Bun the current OpenClaw process is on.
  try {
    // 返回
    const execDir = path.dirname(execPath);
    if (isExecutable(execPath)) {
      // 如果当前的可执行文件路径是可执行的，则将它所在的目录添加到 PATH 的前面，
      // 这样可以确保在 launchd/minimal 环境下能够找到 `openclaw` 可执行文件。
      prepend.push(execDir);
    }
  } catch {
    // ignore
  }

  // Bundled macOS app: `openclaw` lives next to the executable (process.execPath).
  try {
    // 在 macOS 应用程序中，
    // `openclaw` 可执行文件通常与当前的可执行文件在同一目录下，
    const execDir = path.dirname(execPath);
    const siblingCli = path.join(execDir, "openclaw");
    if (isExecutable(siblingCli)) {
      prepend.push(execDir);
    }
  } catch {
    // ignore
  }

  // Project-local installs are a common repo-based attack vector (bin hijacking). Keep this
  // disabled by default; if an operator explicitly enables it, only append (never prepend).
  // 禁止将项目本地的 node_modules/.bin 目录加入系统的 PATH 环境变量
  // 如果手工启用了这个功能，
  // 则将项目本地的 node_modules/.bin 目录添加到 PATH 的后面，而不是前面，
  // 以避免潜在的安全风险（如 PATH 劫持）。
  const allowProjectLocalBin =
    opts.allowProjectLocalBin === true ||
    isTruthyEnvValue(process.env.OPENCLAW_ALLOW_PROJECT_LOCAL_BIN);
  if (allowProjectLocalBin) {
    // 如果允许项目本地的 bin 目录，
    // 则将当前工作目录下的 node_modules/.bin 目录添加到 PATH 的后面，
    const localBinDir = path.join(cwd, "node_modules", ".bin");
    if (isExecutable(path.join(localBinDir, "openclaw"))) {
      // 存在 openclaw 文件，则将这个目录添加到 PATH 的后面，
      append.push(localBinDir);
    }
  }

  // Only immutable OS directories go in prepend so they take priority over
  // user-writable locations, preventing PATH hijack of system binaries.
  prepend.push("/usr/bin", "/bin");

  // User-writable / package-manager directories are appended so they never
  // shadow trusted OS binaries.
  // This includes Brew/Homebrew dirs, which are useful for finding `openclaw`
  // in launchd/minimal environments but must not be treated as trusted.
  append.push(...resolveBrewPathDirs({ homeDir }));
  // mise 版本管理器
  const miseDataDir = process.env.MISE_DATA_DIR ?? path.join(homeDir, ".local", "share", "mise");
  // mise 的 shims 目录  （shims 垫片，主要方法版本切换。）
  // ~/.local/share/mise/shims/
  const miseShims = path.join(miseDataDir, "shims");
  if (isDirectory(miseShims)) {
    append.push(miseShims);
  }
  if (platform === "darwin") {
    // Darwin 是 macOS 操作系统底层的开源核心，也就是 macOS 的内核和核心操作系统组件。
    append.push(path.join(homeDir, "Library", "pnpm"));
  }
  if (process.env.XDG_BIN_HOME) {
    append.push(process.env.XDG_BIN_HOME);
  }
  append.push(path.join(homeDir, ".local", "bin"));
  append.push(path.join(homeDir, ".local", "share", "pnpm"));
  append.push(path.join(homeDir, ".bun", "bin"));
  append.push(path.join(homeDir, ".yarn", "bin"));

  return { prepend: prepend.filter(isDirectory), append: append.filter(isDirectory) };
}

/**
 * Best-effort PATH bootstrap so skills that require the `openclaw` CLI can run
 * under launchd/minimal environments (and inside the macOS app bundle).
 */
// 把 `openclaw` 可执行文件所在的目录添加到 PATH 环境变量中，
// 确保在 launchd/minimal 环境下能够找到 `openclaw` 可执行文件。
// 保证 OpenClawCli 在 PATH 中，
// 优先级高于系统目录（/usr/bin, /bin），
// 低于用户目录和包管理器目录（如 Brew/Homebrew）。
export function ensureOpenClawCliOnPath(opts: EnsureOpenClawPathOpts = {}) {
  if (isTruthyEnvValue(process.env.OPENCLAW_PATH_BOOTSTRAPPED)) {
    // 已经设置了 PATH_BOOTSTRAPPED 环境变量，
    // 说明 PATH 已经被引导过了，因此直接返回，不需要再次引导。
    return;
  }
  process.env.OPENCLAW_PATH_BOOTSTRAPPED = "1";

  const existing = opts.pathEnv ?? process.env.PATH ?? "";
  const { prepend, append } = candidateBinDirs(opts);
  if (prepend.length === 0 && append.length === 0) {
    return;
  }

  //合并现有的 PATH 环境变量与要添加的路径，确保不重复，并且保持顺序。
  const merged = mergePath({ existing, prepend, append });
  if (merged) {
    process.env.PATH = merged;
  }
}
