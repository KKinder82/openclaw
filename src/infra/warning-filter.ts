import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const warningFilterKey = Symbol.for("openclaw.warning-filter");

export type ProcessWarning = {
  code?: string;
  name?: string;
  message?: string;
};

type ProcessWarningInstallState = {
  installed: boolean;
};

// 过滤掉 Node.js 内部已废弃但仍存在的警告，避免干扰用户。
export function shouldIgnoreWarning(warning: ProcessWarning): boolean {
  if (warning.code === "DEP0040" && warning.message?.includes("punycode")) {
    return true;
  }
  if (warning.code === "DEP0060" && warning.message?.includes("util._extend")) {
    return true;
  }
  if (
    warning.name === "ExperimentalWarning" &&
    warning.message?.includes("SQLite is an experimental feature")
  ) {
    return true;
  }
  return false;
}

// Node.js 的 `process.aemitWrning` 支持多种调用方式，
// 以下函数将这些不同的调用方式规范化为一个统一的 `ProcessWarning` 对象，
// 方便后续过滤逻辑使用。
function normalizeWarningArgs(args: unknown[]): ProcessWarning {
  const warningArg = args[0];
  const secondArg = args[1];
  const thirdArg = args[2];
  let name: string | undefined;
  let code: string | undefined;
  let message: string | undefined;

  if (warningArg instanceof Error) {
    name = warningArg.name;
    message = warningArg.message;
    code = (warningArg as Error & { code?: string }).code;
  } else if (typeof warningArg === "string") {
    message = warningArg;
  }

  if (secondArg && typeof secondArg === "object" && !Array.isArray(secondArg)) {
    const options = secondArg as { type?: unknown; code?: unknown };
    if (typeof options.type === "string") {
      name = options.type;
    }
    if (typeof options.code === "string") {
      code = options.code;
    }
  } else {
    if (typeof secondArg === "string") {
      name = secondArg;
    }
    if (typeof thirdArg === "string") {
      code = thirdArg;
    }
  }

  return { name, code, message };
}

// 安装全局的 `process.emitWarning` 包装器，过滤掉不需要的警告。
export function installProcessWarningFilter(): void {
  const state = resolveGlobalSingleton<ProcessWarningInstallState>(warningFilterKey, () => ({
    installed: false,
  }));
  if (state.installed) {
    return;
  }

  const originalEmitWarning = process.emitWarning.bind(process);
  // 自定义的 `emitWarning`
  // 包装器会先检查是否应该忽略当前警告，
  // 如果是，则直接返回；否则，按照原有的逻辑发出警告。
  const wrappedEmitWarning: typeof process.emitWarning = ((...args: unknown[]) => {
    if (shouldIgnoreWarning(normalizeWarningArgs(args))) {
      return;
    }
    if (
      args[0] instanceof Error &&
      args[1] &&
      typeof args[1] === "object" &&
      !Array.isArray(args[1])
    ) {
      const warning = args[0];
      const emitted = Object.assign(new Error(warning.message), {
        name: warning.name,
        code: (warning as Error & { code?: string }).code,
      });
      process.emit("warning", emitted);
      return;
    }
    // 对于其他调用方式，直接调用原始的 `emitWarning`。
    Reflect.apply(originalEmitWarning, process, args);
    return;
  }) as typeof process.emitWarning;

  process.emitWarning = wrappedEmitWarning;
  state.installed = true;
}
