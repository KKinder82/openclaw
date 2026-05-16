import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveConfigDir } from "../utils.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeEnvVarKey,
} from "./host-env-security.js";

const logger = createSubsystemLogger("infra:dotenv");

const BLOCKED_WORKSPACE_DOTENV_KEYS = new Set([
  "ALL_PROXY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "BROWSER_EXECUTABLE_PATH",
  "CLAWHUB_AUTH_TOKEN",
  "CLAWHUB_CONFIG_PATH",
  "CLAWHUB_TOKEN",
  "CLAWHUB_URL",
  "CLOUDSDK_PYTHON",
  "COMSPEC",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "HOMEBREW_BREW_FILE",
  "HOMEBREW_PREFIX",
  "IRC_HOST",
  "LOCALAPPDATA",
  "MATTERMOST_URL",
  "MATRIX_HOMESERVER",
  "MINIMAX_API_HOST",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NO_PROXY",
  "NPM_EXECPATH",
  "OPENAI_API_KEY",
  "OPENAI_API_KEYS",
  "OPENCLAW_AGENT_DIR",
  "OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES",
  "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS",
  "OPENCLAW_ALLOW_PROJECT_LOCAL_BIN",
  "OPENCLAW_BROWSER_EXECUTABLE_PATH",
  "OPENCLAW_BROWSER_CONTROL_MODULE",
  "OPENCLAW_BUNDLED_HOOKS_DIR",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_BUNDLED_SKILLS_DIR",
  "OPENCLAW_CACHE_TRACE",
  "OPENCLAW_CACHE_TRACE_FILE",
  "OPENCLAW_CACHE_TRACE_MESSAGES",
  "OPENCLAW_CACHE_TRACE_PROMPT",
  "OPENCLAW_CACHE_TRACE_SYSTEM",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_GATEWAY_SECRET",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_HOME",
  "OPENCLAW_LIVE_ANTHROPIC_KEY",
  "OPENCLAW_LIVE_ANTHROPIC_KEYS",
  "OPENCLAW_LIVE_GEMINI_KEY",
  "OPENCLAW_LIVE_OPENAI_KEY",
  "OPENCLAW_MPM_CATALOG_PATHS",
  "OPENCLAW_NODE_EXEC_FALLBACK",
  "OPENCLAW_NODE_EXEC_HOST",
  "OPENCLAW_OAUTH_DIR",
  "OPENCLAW_PINNED_PYTHON",
  "OPENCLAW_PINNED_WRITE_PYTHON",
  "OPENCLAW_PLUGIN_INSTALL_OVERRIDES",
  "OPENCLAW_PLUGIN_CATALOG_PATHS",
  "OPENCLAW_PROFILE",
  "OPENCLAW_RAW_STREAM",
  "OPENCLAW_RAW_STREAM_PATH",
  "OPENCLAW_SHOW_SECRETS",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_TEST_TAILSCALE_BINARY",
  "PI_CODING_AGENT_DIR",
  "PATH",
  "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "STATE_DIRECTORY",
  "SYNOLOGY_CHAT_INCOMING_URL",
  "SYNOLOGY_NAS_HOST",
  "UV_PYTHON",
]);

// Block endpoint redirection for any service without overfitting per-provider names.
// `_HOMESERVER` covers Matrix's per-account scoped keys (MATRIX_<ACCOUNT>_HOMESERVER)
// in addition to the bare MATRIX_HOMESERVER listed above.
const BLOCKED_WORKSPACE_DOTENV_SUFFIXES = ["_API_HOST", "_BASE_URL", "_HOMESERVER"];
const BLOCKED_WORKSPACE_DOTENV_PREFIXES = [
  "ANTHROPIC_API_KEY_",
  "CLAWHUB_",
  "OPENAI_API_KEY_",
  // Workspace .env is untrusted; reserve the full OpenClaw runtime namespace
  // for shell/global config so new OPENCLAW_* controls are fail-closed by default.
  "OPENCLAW_",
  "OPENCLAW_CLAWHUB_",
  "OPENCLAW_DISABLE_",
  "OPENCLAW_SKIP_",
  "OPENCLAW_UPDATE_",
];

function shouldBlockWorkspaceRuntimeDotEnvKey(key: string): boolean {
  return isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key);
}

// 不被允许使用的 key名称。
function shouldBlockRuntimeDotEnvKey(key: string): boolean {
  // The global ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env) is a trusted
  // operator-controlled runtime surface. Workspace .env is untrusted and gets
  // the strict blocklist, but the trusted global fallback is allowed to set
  // runtime vars like proxy/base-url/auth values.
  void key;
  return false;
}

function shouldBlockWorkspaceDotEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    shouldBlockWorkspaceRuntimeDotEnvKey(upper) ||
    BLOCKED_WORKSPACE_DOTENV_KEYS.has(upper) ||
    BLOCKED_WORKSPACE_DOTENV_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
    BLOCKED_WORKSPACE_DOTENV_SUFFIXES.some((suffix) => upper.endsWith(suffix))
  );
}

type DotEnvEntry = {
  key: string;
  value: string;
};

type LoadedDotEnvFile = {
  filePath: string;
  entries: DotEnvEntry[];
};

//读取环境变量文件，返回解析后的键值对列表，同时过滤掉被认为是危险的变量。
function readDotEnvFile(params: {
  filePath: string;
  shouldBlockKey: (key: string) => boolean; // 用于判断是否应该阻止某个环境变量键的函数，通常会检查键名是否在危险列表中。
  quiet?: boolean;
}): LoadedDotEnvFile | null {
  let content: string;
  try {
    content = fs.readFileSync(params.filePath, "utf8");
  } catch (error) {
    if (!params.quiet) {
      const code =
        error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      if (code !== "ENOENT") {
        // ENOENT 是 Node.js 环境中的一个标准系统错误代码，代表 Error NO ENTry（错误：没有这个目录或文件）。
        logger.warn(`Failed to read ${params.filePath}: ${String(error)}`, { error });
      }
    }
    return null;
  }

  let parsed: Record<string, string>;
  try {
    // 分析 .env 文件的内容，
    // 提取出环境变量的键值对。
    parsed = dotenv.parse(content);
  } catch (error) {
    if (!params.quiet) {
      logger.warn(`Failed to parse ${params.filePath}: ${String(error)}`, { error });
    }
    return null;
  }
  const entries: DotEnvEntry[] = [];
  for (const [rawKey, value] of Object.entries(parsed)) {
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key || params.shouldBlockKey(key)) {
      // 如果键名无效或被认为是危险的，则跳过该键值对，不将其包含在返回的列表中。
      continue;
    }
    entries.push({ key, value });
  }
  return { filePath: params.filePath, entries };
}

// 读取工作区 .env 文件，
// 覆盖 process.env 中未定义的变量，但不允许覆盖任何被认为是危险的变量（如路径、代理设置、OpenClaw 认证/控制变量等）。
export function loadWorkspaceDotEnvFile(filePath: string, opts?: { quiet?: boolean }) {
  const parsed = readDotEnvFile({
    filePath,
    shouldBlockKey: shouldBlockWorkspaceDotEnvKey,
    quiet: opts?.quiet ?? true,
  });
  if (!parsed) {
    return;
  }
  for (const { key, value } of parsed.entries) {
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
  }
}

// 读取已经解析的 .env 文件列表，
function loadParsedDotEnvFiles(files: LoadedDotEnvFile[]) {
  const preExistingKeys = new Set(Object.keys(process.env));
  const conflicts = new Map<string, { keptPath: string; ignoredPath: string; keys: Set<string> }>();
  const firstSeen = new Map<string, { value: string; filePath: string }>();

  for (const file of files) {
    for (const { key, value } of file.entries) {
      if (preExistingKeys.has(key)) {
        continue;
      }
      const previous = firstSeen.get(key);
      if (previous) {
        if (previous.value !== value) {
          const conflictKey = `${previous.filePath}\u0000${file.filePath}`;
          const existing = conflicts.get(conflictKey);
          if (existing) {
            existing.keys.add(key);
          } else {
            conflicts.set(conflictKey, {
              keptPath: previous.filePath,
              ignoredPath: file.filePath,
              keys: new Set([key]),
            });
          }
        }
        continue;
      }
      firstSeen.set(key, { value, filePath: file.filePath });
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }

  for (const conflict of conflicts.values()) {
    const keys = [...conflict.keys].toSorted();
    if (keys.length === 0) {
      continue;
    }
    logger.warn(
      `Conflicting values in ${conflict.keptPath} and ${conflict.ignoredPath} for ${keys.join(", ")}; keeping ${conflict.keptPath}.`,
      { keptPath: conflict.keptPath, ignoredPath: conflict.ignoredPath, keys },
    );
  }
}

export function loadGlobalRuntimeDotEnvFiles(opts?: { quiet?: boolean; stateEnvPath?: string }) {
  const quiet = opts?.quiet ?? true;
  // stateEnvPath .env 文件路径。
  const stateEnvPath = opts?.stateEnvPath ?? path.join(resolveConfigDir(process.env), ".env");
  // ~/.openclaw/.env 是全局默认位置，但如果 OPENCLAW_STATE_DIR 被显式设置为非默认位置，则不加载 ~/.openclaw/.env，避免与用户期望的 state dir 配置冲突。
  const defaultStateEnvPath = path.join(
    resolveRequiredHomeDir(process.env, os.homedir),
    ".openclaw",
    ".env",
  );
  // 只有当 OPENCLAW_STATE_DIR 没有被显式设置为非默认位置时，
  // 才加载全局默认位置 ~/.openclaw/.env。
  const hasExplicitNonDefaultStateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() !== undefined &&
    path.resolve(stateEnvPath) !== path.resolve(defaultStateEnvPath);
  const parsedFiles = [
    readDotEnvFile({
      filePath: stateEnvPath,
      shouldBlockKey: shouldBlockRuntimeDotEnvKey,
      quiet,
    }),
  ];
  if (!hasExplicitNonDefaultStateDir) {
    // 加载全局默认位置 ~/.openclaw/.env，作为 stateEnvPath 的后备选项，
    parsedFiles.push(
      readDotEnvFile({
        filePath: path.join(
          resolveRequiredHomeDir(process.env, os.homedir),
          ".config",
          "openclaw",
          "gateway.env",
        ),
        shouldBlockKey: shouldBlockRuntimeDotEnvKey,
        quiet,
      }),
    );
  }
  const parsed = parsedFiles.filter((file): file is LoadedDotEnvFile => file !== null);
  loadParsedDotEnvFiles(parsed);
}

// 从 .env 文件中 加载 环境变量
export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;
  // 首先加载工作区 .env 文件，
  const cwdEnvPath = path.join(process.cwd(), ".env");
  loadWorkspaceDotEnvFile(cwdEnvPath, { quiet });

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  loadGlobalRuntimeDotEnvFiles({ quiet });
}
