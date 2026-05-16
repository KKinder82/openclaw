#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 12;
const MIN_NODE_VERSION = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`;

const parseNodeVersion = (rawVersion) => {
  const [majorRaw = "0", minorRaw = "0"] = rawVersion.split(".");
  return {
    major: Number(majorRaw),
    minor: Number(minorRaw),
  };
};

const isSupportedNodeVersion = (version) =>
  version.major > MIN_NODE_MAJOR ||
  (version.major === MIN_NODE_MAJOR && version.minor >= MIN_NODE_MINOR);

const ensureSupportedNodeVersion = () => {
  if (isSupportedNodeVersion(parseNodeVersion(process.versions.node))) {
    return;
  }

  process.stderr.write(
    `openclaw: Node.js v${MIN_NODE_VERSION}+ is required (current: v${process.versions.node}).\n` +
      "If you use nvm, run:\n" +
      `  nvm install ${MIN_NODE_MAJOR}\n` +
      `  nvm use ${MIN_NODE_MAJOR}\n` +
      `  nvm alias default ${MIN_NODE_MAJOR}\n`,
  );
  process.exit(1);
};

ensureSupportedNodeVersion();

// 是否是从源代码树或 GitHub 源代码归档启动：检查特定于源代码存在的标志性文件或目录。
const isSourceCheckoutLauncher = () =>
  existsSync(new URL("./.git", import.meta.url)) || // Git 存储库标志
  existsSync(new URL("./src/entry.ts", import.meta.url)); // TypeScript 源代码标志

// 是否禁用了 Node.js 编译缓存功能。
const isNodeCompileCacheDisabled = () => process.env.NODE_DISABLE_COMPILE_CACHE !== undefined;

// Node编译缓冲功能是否要求启用。
const isNodeCompileCacheRequested = () =>
  // 如果明确设置了 `NODE_COMPILE_CACHE` 环境变量，则启用编译缓存；
  // 否则，如果未禁用且模块支持，则启用。
  Boolean(process.env.NODE_COMPILE_CACHE) && !isNodeCompileCacheDisabled();

// 将任意字符串转换为适合文件路径的安全格式，避免不合法字符并提供默认值。
const sanitizeCompileCachePathSegment = (value) => {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
};
const readPackageVersion = () => {
  try {
    const parsed = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    if (typeof parsed?.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to an install-metadata-only cache key.
  }
  return "unknown";
};

// 解析预期的编译缓存目录，
// 基于安装环境和包版本，确保不同版本和安装方式的缓存隔离。
// 返回：`<baseDirectory>/openclaw/<version>/<installMarker>`，
// 其中
// `<baseDirectory>` 是用户指定的编译缓存目录或系统临时目录，
// `<version>` 是包版本，
// `<installMarker>` 是基于 `package.json` 的修改时间和大小生成的标记，用于区分不同的安装实例。
const resolvePackagedCompileCacheDirectory = () => {
  const packageJsonUrl = new URL("./package.json", import.meta.url);
  const version = sanitizeCompileCachePathSegment(readPackageVersion());
  let installMarker = "no-package-json";
  try {
    const stat = statSync(packageJsonUrl);
    installMarker = `${Math.trunc(stat.mtimeMs)}-${stat.size}`;
  } catch {
    // Package archives should always have package.json, but keep startup best-effort.
  }
  const baseDirectory = isNodeCompileCacheRequested()
    ? process.env.NODE_COMPILE_CACHE
    : path.join(os.tmpdir(), "node-compile-cache");
  return path.join(
    baseDirectory,
    "openclaw",
    version,
    sanitizeCompileCachePathSegment(installMarker),
  );
};

// 如果是从源代码树或 GitHub 源代码归档启动，
// 并且编译缓存未禁用但也未请求，
// 则重新启动当前进程，禁用编译缓存。
const respawnSignals =
  process.platform === "win32"
    ? ["SIGTERM", "SIGINT", "SIGBREAK"]
    : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];
const respawnSignalExitGraceMs = 1_000;
const respawnSignalForceKillGraceMs = 1_000;

const runRespawnedChild = (command, args, env) => {
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
  });
  const listeners = new Map();
  // This intentionally overlaps with src/entry.compile-cache.ts; keep the
  // respawn supervision behavior in sync until the launcher can share TS code.
  // Give the child a moment to honor forwarded signals, then exit the wrapper so
  // a child that ignores SIGTERM cannot keep the launcher alive indefinitely.
  let signalExitTimer = null;
  let signalForceKillTimer = null;
  const detach = () => {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
    listeners.clear();
    if (signalExitTimer) {
      clearTimeout(signalExitTimer);
      signalExitTimer = null;
    }
    if (signalForceKillTimer) {
      clearTimeout(signalForceKillTimer);
      signalForceKillTimer = null;
    }
  };
  const forceKillChild = () => {
    try {
      child.kill(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
    } catch {
      // Best-effort shutdown fallback.
    }
  };
  const requestChildTermination = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort shutdown fallback.
    }
    signalForceKillTimer = setTimeout(() => {
      forceKillChild();
      process.exit(1);
    }, respawnSignalForceKillGraceMs);
    signalForceKillTimer.unref?.();
  };
  const scheduleParentExit = () => {
    if (signalExitTimer) {
      return;
    }
    signalExitTimer = setTimeout(() => {
      requestChildTermination();
    }, respawnSignalExitGraceMs);
    signalExitTimer.unref?.();
  };
  for (const signal of respawnSignals) {
    const listener = () => {
      try {
        child.kill(signal);
      } catch {
        // Best-effort signal forwarding.
      }
      scheduleParentExit();
    };
    try {
      process.on(signal, listener);
      listeners.set(signal, listener);
    } catch {
      // Unsupported signal on this platform.
    }
  }
  child.once("exit", (code, signal) => {
    detach();
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
  child.once("error", (error) => {
    detach();
    process.stderr.write(
      `[openclaw] Failed to respawn launcher: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    process.exit(1);
  });
  return true;
};

// 禁用编译缓存的重新启动（如果需要）：
const respawnWithoutCompileCacheIfNeeded = () => {
  // 如果不是从源代码树或 GitHub 源代码归档启动，不满足要求。
  if (!isSourceCheckoutLauncher()) {
    return false;
  }
  // 如果编译缓存已禁用或已请求，则不满足要求。
  if (process.env.OPENCLAW_SOURCE_COMPILE_CACHE_RESPAWNED === "1") {
    return false;
  }
  // 如果模块不支持编译缓存功能，也不满足要求。
  if (!module.getCompileCacheDir?.() && !isNodeCompileCacheRequested()) {
    return false;
  }
  const env = {
    ...process.env,
    NODE_DISABLE_COMPILE_CACHE: "1", // 禁用 Node.js 编译缓存功能，确保从源代码启动时不使用编译缓存。
    OPENCLAW_SOURCE_COMPILE_CACHE_RESPAWNED: "1", // 设置一个环境变量，标记已经重新启动过，以避免重复重启。
  };
  delete env.NODE_COMPILE_CACHE;

  // 启动一个新的 Node.js 进程，运行相同的脚本（当前文件），传递相同的命令行参数，并使用修改后的环境变量。
  // `stdio: "inherit"` 选项确保子进程共享父进程的标准输入、输出和错误流，使得输出和交互行为保持一致。
  // const result = spawnSync(
  //   process.execPath,
  //   [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
  //   {
  //     stdio: "inherit",
  //   env,
  //   },
  // );
  // if (result.error) {
  //   throw result.error;
  // }
  // // 重新启动后直接退出当前进程，状态码与子进程相同（如果可用），确保正确传递成功或错误状态。
  // process.exit(result.status ?? 1);

  return runRespawnedChild(
    process.execPath,
    [...process.execArgv, 
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2)],  env,
  );

};

respawnWithoutCompileCacheIfNeeded();

// 如果编译缓存功能可用，
// 但当前目录不在预期的缓存目录中，则重新启动当前进程，使用预期的缓存目录。
const respawnWithPackagedCompileCacheIfNeeded = () => {
  // 如果是 源文件目录 或者 Node.js 编译缓存功能被禁用，则不满足要求。
  if (isSourceCheckoutLauncher() || isNodeCompileCacheDisabled()) {
    return false;
  }
  // 如果已经重新启动过以启用编译缓存，则不满足要求。
  if (process.env.OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED === "1") {
    return false;
  }
  // 如果模块不支持编译缓存功能，也不满足要求。
  const currentDirectory = module.getCompileCacheDir?.();
  if (!currentDirectory) {
    return false;
  }
  // 如果当前编译缓存目录已经是预期的目录，则不满足要求。
  const desiredDirectory = resolvePackagedCompileCacheDirectory();
  if (path.resolve(currentDirectory) === path.resolve(desiredDirectory)) {
    return false;
  }
  const env = {
    ...process.env,
    NODE_COMPILE_CACHE: desiredDirectory, // 设置 `NODE_COMPILE_CACHE` 环境变量，指定预期的编译缓存目录。
    OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: "1", // 设置一个环境变量，标记已经重新启动过，以避免重复重启。
  };
  return runRespawnedChild(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    env,
  );
};

const waitingForCompileCacheRespawn =
  respawnWithoutCompileCacheIfNeeded() || respawnWithPackagedCompileCacheIfNeeded();

// 正常启动。
// 模块支持编译缓存功能，
// 且没有禁用编译缓存
// 且不是从源代码树或 GitHub 源代码归档启动，
// 则启用编译缓存，使用预期的缓存目录。
// https://nodejs.org/api/module.html#module-compile-cache
if (
  !waitingForCompileCacheRespawn &&
  module.enableCompileCache &&
  !isNodeCompileCacheDisabled() &&
  !isSourceCheckoutLauncher()
) {
  try {
    module.enableCompileCache(resolvePackagedCompileCacheDirectory());
  } catch {
    // Ignore errors
  }
}

// 检查是否是模块未找到错误，避免误捕获其他类型的错误。
const isModuleNotFoundError = (err) =>
  err && typeof err === "object" && "code" in err && err.code === "ERR_MODULE_NOT_FOUND";

// 检查错误是否是直接请求特定模块时的模块未找到错误，避免误捕获其他模块解析过程中发生的错误。
const isDirectModuleNotFoundError = (err, specifier) => {
  // 首先检查是否是模块未找到错误，如果不是，则直接返回 false。
  if (!isModuleNotFoundError(err)) {
    return false;
  }
  // 检查是否是直接请求特定模块时的模块未找到错误：
  // Node.js 的模块解析错误通常会包含一个 `url` 属性，指示哪个模块未找到。
  const expectedUrl = new URL(specifier, import.meta.url);
  if ("url" in err && err.url === expectedUrl.href) {
    return true;
  }

  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  const expectedPath = fileURLToPath(expectedUrl);
  return (
    message.includes(`Cannot find module '${expectedPath}'`) ||
    message.includes(`Cannot find module "${expectedPath}"`)
  );
};

// 安装进程警告过滤器：
// 尝试导入并安装一个模块，该模块会过滤掉与当前启动环境相关的已知无害的警告，保持输出清洁和用户友好。
const installProcessWarningFilter = async () => {
  // Keep bootstrap warnings consistent with the TypeScript runtime.
  for (const specifier of ["./dist/warning-filter.js", "./dist/warning-filter.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.installProcessWarningFilter === "function") {
        mod.installProcessWarningFilter();
        // 安装完成后立即返回，避免在后续的模块加载过程中产生不必要的警告。
        return;
      }
    } catch (err) {
      if (isDirectModuleNotFoundError(err, specifier)) {
        continue;
      }
      throw err;
    }
  }
};

const tryImport = async (specifier) => {
  try {
    await import(specifier);
    return true;
  } catch (err) {
    // Only swallow direct entry misses; rethrow transitive resolution failures.
    if (isDirectModuleNotFoundError(err, specifier)) {
      return false;
    }
    throw err;
  }
};

const exists = async (specifier) => {
  try {
    await access(new URL(specifier, import.meta.url));
    return true;
  } catch {
    return false;
  }
};

const buildMissingEntryErrorMessage = async () => {
  const lines = ["openclaw: missing dist/entry.(m)js (build output)."];
  if (!(await exists("./src/entry.ts"))) {
    return lines.join("\n");
  }

  lines.push("This install looks like an unbuilt source tree or GitHub source archive.");
  lines.push(
    "Build locally with `pnpm install && pnpm build`, or install a built package instead.",
  );
  lines.push(
    "For pinned GitHub installs, use `npm install -g github:openclaw/openclaw#<ref>` instead of a raw `/archive/<ref>.tar.gz` URL.",
  );
  lines.push("For releases, use `npm install -g openclaw@latest`.");
  return lines.join("\n");
};

// 是否是直接请求根帮助文本的调用（`openclaw --help` 或 `openclaw -h`）
const isBareRootHelpInvocation = (argv) =>
  argv.length === 3 && (argv[2] === "--help" || argv[2] === "-h");

const isBrowserHelpInvocation = (argv) =>
  argv.length === 4 && argv[2] === "browser" && (argv[3] === "--help" || argv[3] === "-h");

// 是否禁用了显示命令行帮助的快速路径：通过环境变量 `OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH` 显式禁用。
// FastPath ：是否如何不对直接进行 Help 显示。
const isHelpFastPathDisabled = () =>
  process.env.OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH === "1";

const loadPrecomputedHelpText = (key) => {
  try {
    const raw = readFileSync(new URL("./dist/cli-startup-metadata.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw);
    const value = parsed?.[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

// 输出根帮助文本的快速路径：如果是直接请求根帮助文本的调用，则尝试加载预计算的帮助文本或直接导入输出函数，避免完整启动。
const tryOutputBareRootHelp = async () => {
  //如果没有明确的请求根帮助文本的调用，则不满足要求。
  if (!isBareRootHelpInvocation(process.argv)) {
    return false;
  }
  const precomputed = loadPrecomputedHelpText("rootHelpText");
  if (precomputed) {
    process.stdout.write(precomputed);
    return true;
  }
  for (const specifier of ["./dist/cli/program/root-help.js", "./dist/cli/program/root-help.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.outputRootHelp === "function") {
        mod.outputRootHelp();
        return true;
      }
    } catch (err) {
      if (isDirectModuleNotFoundError(err, specifier)) {
        continue;
      }
      throw err;
    }
  }
  return false;
};

const tryOutputBrowserHelp = () => {
  if (!isBrowserHelpInvocation(process.argv)) {
    return false;
  }
  const precomputed = loadPrecomputedHelpText("browserHelpText");
  if (!precomputed) {
    return false;
  }
  process.stdout.write(precomputed);
  return true;
};


if (!isHelpFastPathDisabled() && (await tryOutputBareRootHelp())) {
  // 显示命令行帮助的快速路径：如果是直接请求根帮助文本的调用，则尝试加载预计算的帮助文本或直接导入输出函数，避免完整启动。
  // OK
} else if (!isHelpFastPathDisabled() && tryOutputBrowserHelp()) {
  // 显示浏览器帮助的快速路径：如果是直接请求浏览器帮助文本的调用，则尝试加载预计算的帮助文本，避免完整启动。
  // OK
} else {
  await installProcessWarningFilter();
  if (await tryImport("./dist/entry.js")) {
    if (!waitingForCompileCacheRespawn) {
      if (!isHelpFastPathDisabled() && (await tryOutputBareRootHelp())) {
        // OK
      } else if (!isHelpFastPathDisabled() && tryOutputBrowserHelp()) {
        // OK
      } else {
        await installProcessWarningFilter();
        if (await tryImport("./dist/entry.js")) {
          // OK
        } else if (await tryImport("./dist/entry.mjs")) {
          // OK
        } else {
          throw new Error(await buildMissingEntryErrorMessage());
        }
      }
    }
  }
}
