import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { enableCompileCache, getCompileCacheDir } from "node:module";
import os from "node:os";
import path from "node:path";

// 返回entryFile所在目录
// 安装 entryFile所在目录为 dist或src 时，则返回 dist或src的父目录
export function resolveEntryInstallRoot(entryFile: string): string {
  const entryDir = path.dirname(entryFile); //整个目录（不是目录名称）
  const entryParent = path.basename(entryDir); // 文件(夹)名
  return entryParent === "dist" || entryParent === "src" ? path.dirname(entryDir) : entryDir;
}

// 是否不是源代码的根目录
export function isSourceCheckoutInstallRoot(installRoot: string): boolean {
  return (
    existsSync(path.join(installRoot, ".git")) ||
    existsSync(path.join(installRoot, "src", "entry.ts"))
  );
}

function isNodeCompileCacheDisabled(env: NodeJS.ProcessEnv | undefined): boolean {
  return env?.NODE_DISABLE_COMPILE_CACHE !== undefined;
}

function isNodeCompileCacheRequested(env: NodeJS.ProcessEnv | undefined): boolean {
  return env?.NODE_COMPILE_CACHE !== undefined && !isNodeCompileCacheDisabled(env);
}

// 应不应当启用 OpenClaw 编译缓存：
export function shouldEnableOpenClawCompileCache(params: {
  env?: NodeJS.ProcessEnv;
  installRoot: string;
}): boolean {
  if (isNodeCompileCacheDisabled(params.env)) {
    // 显式禁用编译缓存，无论其他条件如何，都不启用。
    return false;
  }
  // 如果是源文件目录，则也不应当启用；
  return !isSourceCheckoutInstallRoot(params.installRoot);
}

function sanitizeCompileCachePathSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
}

function readPackageVersion(packageJsonPath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      typeof parsed.version === "string" &&
      parsed.version.trim().length > 0
    ) {
      return parsed.version;
    }
  } catch {
    // Fall through to an install-metadata-only cache key.
  }
  return "unknown";
}

//解析 CLI 容器目标（如果有的话），
// 例如 `openclaw gateway`，
// 并返回一个表示目标类型的字符串（如 "gateway"）或 null（如果没有特定目标）。
export function resolveOpenClawCompileCacheDirectory(params: {
  env?: NodeJS.ProcessEnv;
  installRoot: string;
}): string {
  const env = params.env ?? process.env;
  const packageJsonPath = path.join(params.installRoot, "package.json");
  const version = sanitizeCompileCachePathSegment(readPackageVersion(packageJsonPath));
  let installMarker = "no-package-json";
  try {
    const stat = statSync(packageJsonPath);
    installMarker = `${Math.trunc(stat.mtimeMs)}-${stat.size}`;
  } catch {
    // Package archives should always have package.json, but keep startup best-effort.
  }
  const baseDirectory =
    env.NODE_COMPILE_CACHE && !isNodeCompileCacheDisabled(env)
      ? env.NODE_COMPILE_CACHE
      : path.join(os.tmpdir(), "node-compile-cache");
  return path.join(
    baseDirectory,
    "openclaw",
    version,
    sanitizeCompileCachePathSegment(installMarker),
  );
}

type OpenClawCompileCacheRespawnPlan = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

// 根据当前环境和安装根目录构建一个重启计划，
// 如果需要禁用编译缓存以确保兼容性或正确性，
// 则返回一个包含重启命令、参数和环境变量的计划对象；否则返回 undefined 表示不需要重启。
export function buildOpenClawCompileCacheRespawnPlan(params: {
  currentFile: string;
  env?: NodeJS.ProcessEnv;
  execArgv?: string[];
  execPath?: string;
  installRoot: string;
  argv?: string[];
  compileCacheDir?: string;
}): OpenClawCompileCacheRespawnPlan | undefined {
  const env = params.env ?? process.env;
  if (!isSourceCheckoutInstallRoot(params.installRoot)) {
    // 不是源代码安装根目录，通常意味着已发布的安装包或全局安装，这些环境通常兼容编译缓存，因此不需要重启。
    return undefined;
  }
  if (env.OPENCLAW_SOURCE_COMPILE_CACHE_RESPAWNED === "1") {
    // 已经重启过一次以禁用编译缓存，但仍然在源代码安装根目录，可能是因为编译缓存不兼容或存在其他问题。
    return undefined;
  }
  if (!params.compileCacheDir && !isNodeCompileCacheRequested(env)) {
    // 没有明确的编译缓存目录，且当前环境没有请求启用 Node.js 内置的编译缓存，
    // 说明不需要重启来禁用编译缓存。
    return undefined;
  }
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_SOURCE_COMPILE_CACHE_RESPAWNED: "1",
  };
  delete nextEnv.NODE_COMPILE_CACHE;
  return {
    command: params.execPath ?? process.execPath,
    args: [
      ...(params.execArgv ?? process.execArgv),
      params.currentFile,
      ...(params.argv ?? process.argv).slice(2),
    ],
    env: nextEnv,
  };
}

export function respawnWithoutOpenClawCompileCacheIfNeeded(params: {
  currentFile: string;
  installRoot: string;
}): boolean {
  const plan = buildOpenClawCompileCacheRespawnPlan({
    currentFile: params.currentFile,
    installRoot: params.installRoot,
    compileCacheDir: getCompileCacheDir?.(),
  });
  if (!plan) {
    // 不需要重启，继续正常启动流程。
    return false;
  }
  // 重启
  const result = spawnSync(plan.command, plan.args, {
    stdio: "inherit",
    env: plan.env,
  });
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
  return true;
}

export function enableOpenClawCompileCache(params: {
  env?: NodeJS.ProcessEnv;
  installRoot: string;
}): void {
  if (!shouldEnableOpenClawCompileCache(params)) {
    // 不应当启用编译缓存，直接返回继续正常启动流程。
    return;
  }
  try {
    //启用编译缓存，并将缓存目录设置为基于安装根目录的特定路径，以避免不同安装之间的缓存冲突。
    enableCompileCache(resolveOpenClawCompileCacheDirectory(params));
  } catch {
    // Best-effort only; never block startup.
  }
}
