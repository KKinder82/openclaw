import os from "node:os";
import path from "node:path";
import { isValueToken } from "../infra/cli-root-options.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { isValidProfileName } from "./profile-utils.js";
import { scanCliRootOptions } from "./root-option-scan.js";
import { takeCliRootOptionValue } from "./root-option-value.js";

type CliProfileParseResult =
  | { ok: true; profile: string | null; argv: string[] }
  | { ok: false; error: string };

function isCommandLocalProfileOption(out: string[]): boolean {
  const [primary, secondary] = resolveCliArgvInvocation(out).commandPath;
  return primary === "qa" && secondary === "matrix";
}

// 分析 概述配置
export function parseCliProfileArgs(argv: string[]): CliProfileParseResult {
  let profile: string | null = null;
  let sawDev = false;

  const scanned = scanCliRootOptions(argv, ({ arg, args, index, out }) => {
    if (arg === "--dev") {
      if (resolveCliArgvInvocation(out).primary === "gateway") {
        out.push(arg);
        return { kind: "handled" };
      }
      if (profile && profile !== "dev") {
        return { kind: "error", error: "Cannot combine --dev with --profile" };
      }
      sawDev = true;
      profile = "dev";
      return { kind: "handled" };
    }

    if (arg === "--profile" || arg.startsWith("--profile=")) {
      if (isCommandLocalProfileOption(out)) {
        out.push(arg);
        if (arg === "--profile" && isValueToken(args[index + 1])) {
          out.push(args[index + 1]);
          return { kind: "handled", consumedNext: true };
        }
        return { kind: "handled" };
      }
      if (sawDev) {
        return { kind: "error", error: "Cannot combine --dev with --profile" };
      }
      const next = args[index + 1];
      const { value, consumedNext } = takeCliRootOptionValue(arg, next);
      if (!value) {
        return { kind: "error", error: "--profile requires a value" };
      }
      if (!isValidProfileName(value)) {
        return {
          kind: "error",
          error: 'Invalid --profile (use letters, numbers, "_", "-" only)',
        };
      }
      profile = value;
      return { kind: "handled", consumedNext };
    }
    return { kind: "pass" };
  });

  if (!scanned.ok) {
    return scanned;
  }

  return { ok: true, profile, argv: scanned.argv };
}

// 解析 CLI 配置文件相关的命令行参数，
// 首先分析是否有容器相关的参数，如果有则设置环境变量以指示当前在容器环境中运行，
// 然后分析是否有 profile 相关的参数，如果有则设置相关环境变量以指示当前的 profile，
// 最后返回处理后的 argv 数组供后续 CLI 启动流程使用。
function resolveProfileStateDir(
  profile: string,
  env: Record<string, string | undefined>,
  homedir: () => string,
): string {
  const suffix = normalizeLowercaseStringOrEmpty(profile) === "default" ? "" : `-${profile}`;
  return path.join(resolveRequiredHomeDir(env as NodeJS.ProcessEnv, homedir), `.openclaw${suffix}`);
}

// 应用 CLI 配置文件相关的环境变量设置，
// 根据传入的 profile 参数设置 OPENCLAW_PROFILE 环境变量，
// 根据 profile 计算并设置 OPENCLAW_STATE_DIR 和 OPENCLAW_CONFIG_PATH 环境变量，
// 如果 profile 是 "dev" 并且没有设置 OPENCLAW_GATEWAY_PORT，则设置默认的端口号为 19001。
export function applyCliProfileEnv(params: {
  profile: string;
  env?: Record<string, string | undefined>;
  homedir?: () => string;
}) {
  const env = params.env ?? (process.env as Record<string, string | undefined>);
  const homedir = params.homedir ?? os.homedir;
  const profile = params.profile.trim();
  if (!profile) {
    return;
  }

  // Convenience only: fill defaults, never override explicit env values.
  env.OPENCLAW_PROFILE = profile;

  const existingStateDir = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
  const stateDir = existingStateDir || resolveProfileStateDir(profile, env, homedir);
  if (!existingStateDir) {
    env.OPENCLAW_STATE_DIR = stateDir;
  }

  // 如果没有显式设置 OPENCLAW_CONFIG_PATH，则默认设置为 stateDir 下的 "openclaw.json"。
  if (!normalizeOptionalString(env.OPENCLAW_CONFIG_PATH)) {
    env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  }

  // 如果 profile 是 "dev" 并且没有设置 OPENCLAW_GATEWAY_PORT，则设置默认的端口号为 19001。
  if (profile === "dev" && !env.OPENCLAW_GATEWAY_PORT?.trim()) {
    env.OPENCLAW_GATEWAY_PORT = "19001";
  }
}
