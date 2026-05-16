import type { SubsystemLogger } from "../logging/subsystem.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

let log: SubsystemLogger | null = null;
let logPromise: Promise<SubsystemLogger> | null = null;
const loggedEnv = new Set<string>();

async function getLog(): Promise<SubsystemLogger> {
  if (!log) {
    logPromise ??= import("../logging/subsystem.js").then(({ createSubsystemLogger }) =>
      createSubsystemLogger("env"),
    );
    log = await logPromise;
  }
  return log;
}

type AcceptedEnvOption = {
  key: string;
  description: string;
  value?: string;
  redact?: boolean;
};

function formatEnvValue(value: string, redact?: boolean): string {
  if (redact) {
    return "<redacted>";
  }
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 160) {
    return singleLine;
  }
  return `${singleLine.slice(0, 160)}…`;
}

export function logAcceptedEnvOption(option: AcceptedEnvOption): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  if (loggedEnv.has(option.key)) {
    return;
  }
  const rawValue = option.value ?? process.env[option.key];
  if (!rawValue || !rawValue.trim()) {
    return;
  }
  loggedEnv.add(option.key);
  void getLog()
    .then((logger) => {
      logger.info(
        `env: ${option.key}=${formatEnvValue(rawValue, option.redact)} (${option.description})`,
      );
    })
    .catch(() => {
      // Best-effort diagnostics only.
    });
}

export function normalizeZaiEnv(): void {
  if (!process.env.ZAI_API_KEY?.trim() && process.env.Z_AI_API_KEY?.trim()) {
    process.env.ZAI_API_KEY = process.env.Z_AI_API_KEY;
  }
}

export function isTruthyEnvValue(value?: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  switch (normalizeLowercaseStringOrEmpty(value)) {
    case "1":
    case "on":
    case "true":
    case "yes":
      return true;
    default:
      return false;
  }
}

// 环境变量中，是否含有 Vitest
export function isVitestRuntimeEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.VITEST === "true" ||
    env.VITEST === "1" ||
    env.VITEST_POOL_ID !== undefined ||
    env.VITEST_WORKER_ID !== undefined ||
    env.NODE_ENV === "test"
  );
}

// 标准化 环境变量，目前包括标准化 ZAI 相关的环境变量（如果存在的话），
export function normalizeEnv(): void {
  normalizeZaiEnv();
}
