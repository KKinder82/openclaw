#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isRootHelpInvocation } from "./cli/argv.js";
import { parseCliContainerArgs, resolveCliContainerTarget } from "./cli/container-target.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import { normalizeWindowsArgv } from "./cli/windows-argv.js";
import {
  enableOpenClawCompileCache,
  resolveEntryInstallRoot,
  respawnWithoutOpenClawCompileCacheIfNeeded,
} from "./entry.compile-cache.js";
import { buildCliRespawnPlan, runCliRespawnPlan } from "./entry.respawn.js";
import { tryHandleRootVersionFastPath } from "./entry.version-fast-path.js";
import { isTruthyEnvValue, normalizeEnv } from "./infra/env.js";
import { isMainModule } from "./infra/is-main.js";
import { ensureOpenClawExecMarkerOnProcess } from "./infra/openclaw-exec-env.js";
import { installProcessWarningFilter } from "./infra/warning-filter.js";

const ENTRY_WRAPPER_PAIRS = [
  { wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" },
  { wrapperBasename: "openclaw.js", entryBasename: "entry.js" },
] as const;

// 检查是否需要强制只读认证存储：
// 如果命令行参数中包含 `secrets audit`，则返回 true，指示需要强制只读认证存储以提高安全性。
function shouldForceReadOnlyAuthStore(argv: string[]): boolean {
  // 从命令行参数中提取非选项参数（即不以 "-" 开头的参数），并检查是否存在连续的 "secrets" 和 "audit" 参数。
  const tokens = argv.slice(2).filter((token) => token.length > 0 && !token.startsWith("-"));
  for (let index = 0; index < tokens.length - 1; index += 1) {
    // 检查连续的两个非空、的非选项参数是否为 "secrets" 和 "audit"，如果是，则返回 true。
    if (tokens[index] === "secrets" && tokens[index + 1] === "audit") {
      return true;
    }
  }
  return false;
}

function createGatewayEntryStartupTrace(argv: string[]) {
  const enabled =
    isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) &&
    argv.slice(2).includes("gateway");
  const started = performance.now();
  let last = started;
  const emit = (name: string, durationMs: number, totalMs: number) => {
    //如果没有启用跟踪，则不输出任何内容。
    if (!enabled) {
      return;
    }
    // 输出跟踪信息到标准错误，格式为 `[gateway] startup trace: entry.<name> <duration>ms total=<total>ms`，其中 `<name>` 是标记名称，`<duration>` 是自上一个标记以来的持续时间，`<total>` 是自启动以来的总持续时间。
    process.stderr.write(
      `[gateway] startup trace: entry.${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`,
    );
  };
  return {
    mark(name: string) {
      const now = performance.now();
      emit(name, now - last, now - started);
      last = now;
    },
    async measure<T>(name: string, run: () => Promise<T>): Promise<T> {
      const before = performance.now();
      try {
        return await run();
      } finally {
        const now = performance.now();
        emit(name, now - before, now - started);
        last = now;
      }
    },
  };
}

//创建 Gateway，返回一个跟踪对象，用于在启动过程中标记不同阶段的持续时间和总时间。
// 跟踪信息仅在环境变量 `OPENCLAW_GATEWAY_STARTUP_TRACE` 被设置为真值且命令行参数中包含 "gateway" 时输出，
// 以帮助调试和性能分析。
const gatewayEntryStartupTrace = createGatewayEntryStartupTrace(process.argv);

// Guard: only run entry-point logic when this file is the main module.
// The bundler may import entry.js as a shared dependency when dist/index.js
// is the actual entry point; without this guard the top-level code below
// would call runCli a second time, starting a duplicate gateway that fails
// on the lock / port and crashes the process.
if (
  !isMainModule({
    currentFile: fileURLToPath(import.meta.url),
    wrapperEntryPairs: [...ENTRY_WRAPPER_PAIRS],
  })
) {
  //不是主模块，说明当前模块被作为依赖导入了，
  // 因此跳过所有入口点相关的副作用代码，避免重复执行 CLI 启动逻辑或其他初始化代码。
  // Imported as a dependency — skip all entry-point side effects.
} else {
  // 主模块，正常执行入口点逻辑。
  const entryFile = fileURLToPath(import.meta.url);
  const installRoot = resolveEntryInstallRoot(entryFile);
// <<<<<<< HEAD
//   // 如果需要求重启以禁用编译缓存（例如因为环境不兼容），则在继续之前进行重启。
//   // 如果重启，则就是不执行后续的 CLI 启动流程了；
//   respawnWithoutOpenClawCompileCacheIfNeeded({
//     currentFile: entryFile,
//     installRoot,
//   });
//   //如果不需要重启，则继续正常启动流程。
//   process.title = "openclaw";
//   ensureOpenClawExecMarkerOnProcess();
//   installProcessWarningFilter();
//   // 标准化环境变量，确保所有环境变量都以一致的格式进行访问和处理。
//   normalizeEnv();
//   enableOpenClawCompileCache({
//     installRoot,
//   });
//   gatewayEntryStartupTrace.mark("bootstrap");
// =======

  const waitingForCompileCacheRespawn = respawnWithoutOpenClawCompileCacheIfNeeded({
    currentFile: entryFile,
    installRoot,
  });
  if (!waitingForCompileCacheRespawn) {
    process.title = "openclaw";
    ensureOpenClawExecMarkerOnProcess();
    installProcessWarningFilter();
    normalizeEnv();
// >>>>>>> 74dae6088b1107ecfaca31c91660b309704c1a8a

    enableOpenClawCompileCache({
      installRoot,
    });
    gatewayEntryStartupTrace.mark("bootstrap");

// <<<<<<< HEAD
//   if (process.argv.includes("--no-color")) {
//     process.env.NO_COLOR = "1";
//     process.env.FORCE_COLOR = "0";
//   }

//   // 保证命令行 重启准备就绪：
//   function ensureCliRespawnReady(): boolean {
//     const plan = buildCliRespawnPlan();
//     if (!plan) {
//       return false;
//     }

//     // 启动
//     const child = spawn(plan.command, plan.argv, {
//       stdio: "inherit",
//       env: plan.env,
//     });

//     // 将父进程和子进程之间的通信桥接起来，以便在子进程中可以发送消息到父进程，
//     // 或者在父进程中监听子进程的事件。
//     attachChildProcessBridge(child);

//     child.once("exit", (code, signal) => {
//       if (signal) {
//         process.exitCode = 1;
//         return;
// =======
    if (shouldForceReadOnlyAuthStore(process.argv)) {
      process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
    }

    if (process.argv.includes("--no-color")) {
      process.env.NO_COLOR = "1";
      process.env.FORCE_COLOR = "0";
    }

    function ensureCliRespawnReady(): boolean {
      const plan = buildCliRespawnPlan();
      if (!plan) {
        return false;
// >>>>>>> 74dae6088b1107ecfaca31c91660b309704c1a8a
      }

// <<<<<<< HEAD
//     child.once("error", (error) => {
//       console.error(
//         "[openclaw] Failed to respawn CLI:",
//         error instanceof Error ? (error.stack ?? error.message) : error,
//       );
//       process.exit(1);
//     });

//     // Parent must not continue running the CLI.
//     return true;
//   }

//   process.argv = normalizeWindowsArgv(process.argv);

//   if (!ensureCliRespawnReady()) {
//     // 如果没准备好重启时
//     // 解析命令行参数，首先解析容器相关的参数，如果解析失败则输出错误并退出，
//     const parsedContainer = parseCliContainerArgs(process.argv);
//     if (!parsedContainer.ok) {
//       console.error(`[openclaw] ${parsedContainer.error}`);
//       process.exit(2);
// =======
      runCliRespawnPlan(plan);
      // Parent must not continue running the CLI.
      return true;
//>>>>>>> 74dae6088b1107ecfaca31c91660b309704c1a8a
    }

    // 标准化命令行参数，
    // 特别是针对 Windows 平台的参数格式进行调整，以确保在后续的 CLI 启动流程中能够正确解析和处理命令行参数。
    process.argv = normalizeWindowsArgv(process.argv);

    if (!ensureCliRespawnReady()) {
      // 如果没准备好重启时
      const parsedContainer = parseCliContainerArgs(process.argv);
      if (!parsedContainer.ok) {
        console.error(`[openclaw] ${parsedContainer.error}`);
        process.exit(2);
      }

      const parsed = parseCliProfileArgs(parsedContainer.argv);
      if (!parsed.ok) {
        // Keep it simple; Commander will handle rich help/errors after we strip flags.
        console.error(`[openclaw] ${parsed.error}`);
        process.exit(2);
      }

      const containerTargetName = resolveCliContainerTarget(process.argv);
      if (containerTargetName && parsed.profile) {
        console.error("[openclaw] --container cannot be combined with --profile/--dev");
        process.exit(2);
      }

      if (parsed.profile) {
        applyCliProfileEnv({ profile: parsed.profile });
        // Keep Commander and ad-hoc argv checks consistent.
        process.argv = parsed.argv;
      }
      gatewayEntryStartupTrace.mark("argv");

      if (!tryHandleRootVersionFastPath(process.argv)) {
        await runMainOrRootHelp(process.argv);
      }
    }
  }
}

// 处理 CLI 根帮助快速路径，
// 如果 argv 中包含 --help 参数或者环境变量 OPENCLAW_HELP 被设置，
// 则直接输出帮助信息并退出，而不需要加载和启动整个 CLI 应用。
export async function tryHandleRootHelpFastPath(
  argv: string[],
  deps: {
    outputPrecomputedRootHelpText?: () => boolean; // 可选的函数，用于输出预计算的根帮助文本，如果返回 true 则表示已经输出了帮助文本，无需继续处理。
    outputRootHelp?: () => void | Promise<void>; // 可选的函数，用于输出根帮助文本，如果提供了这个函数，则会调用它来输出帮助文本。
    onError?: (error: unknown) => void; // 可选的函数，用于处理错误，如果在尝试输出帮助文本时发生错误，则会调用这个函数来处理错误。
    env?: NodeJS.ProcessEnv; // 可选的环境变量对象，用于检查是否设置了 OPENCLAW_HELP 环境变量，如果设置了则表示需要输出帮助文本。
  } = {},
): Promise<boolean> {
  if (resolveCliContainerTarget(argv, deps.env)) {
    // 如果解析到容器目标，说明当前是在容器环境中运行，
    // 此时不处理根帮助快速路径，直接返回 false 以继续正常的 CLI 启动流程。
    return false;
  }
  if (!isRootHelpInvocation(argv)) {
    // 如果当前命令行参数不表示根帮助调用，
    return false;
  }
  const handleError =
    deps.onError ??
    ((error: unknown) => {
      console.error(
        "[openclaw] Failed to display help:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exitCode = 1;
    });
  try {
    if (deps.outputRootHelp) {
      await deps.outputRootHelp();
      return true;
    }
    const outputPrecomputedRootHelpText =
      deps.outputPrecomputedRootHelpText ??
      (await import("./cli/root-help-metadata.js")).outputPrecomputedRootHelpText;
    if (!outputPrecomputedRootHelpText()) {
      const { outputRootHelp } = await import("./cli/program/root-help.js");
      await outputRootHelp();
    }
    return true;
  } catch (error) {
    handleError(error);
    return true;
  }
}

// 运行 CLI 主逻辑/根帮助快速路径，
async function runMainOrRootHelp(argv: string[]): Promise<void> {
  if (await tryHandleRootHelpFastPath(argv)) {
    // 处理了根帮助快速路径，说明已经输出了帮助信息并且不需要继续处理 CLI 启动流程，因此直接返回。
    return;
  }
  try {
    const { runCli } = await gatewayEntryStartupTrace.measure(
      "run-main-import",
      () => import("./cli/run-main.js"),
    );
    // 启动
    await runCli(argv);
  } catch (error) {
    const { formatCliFailureLines } = await import("./cli/failure-output.js");
    for (const line of formatCliFailureLines({
      title: "Could not start the CLI.",
      error,
      argv,
    })) {
      console.error(line);
    }
    process.exit(1);
  }
}
