import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceTemplateDir } from "../../agents/workspace-templates.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { handleReset } from "../../commands/onboard-helpers.js";
import { createConfigIO, replaceConfigFile } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { resolveUserPath, shortenHomePath } from "../../utils.js";

const DEV_IDENTITY_NAME = "C3-PO";
const DEV_IDENTITY_THEME = "protocol droid";
const DEV_IDENTITY_EMOJI = "🤖";
const DEV_AGENT_WORKSPACE_SUFFIX = "dev";

// 加载开发环境的模板文件，如果模板文件存在且格式正确，则返回模板内容；
// 否则返回提供的 fallback 内容。
async function loadDevTemplate(name: string, fallback: string): Promise<string> {
  try {
    const templateDir = await resolveWorkspaceTemplateDir();
    const raw = await fs.promises.readFile(path.join(templateDir, name), "utf-8");
    if (!raw.startsWith("---")) {
      return raw;
    }
    const endIndex = raw.indexOf("\n---", 3);
    if (endIndex === -1) {
      return raw;
    }
    return raw.slice(endIndex + "\n---".length).replace(/^\s+/, "");
  } catch {
    return fallback;
  }
}

// 从环境中解析<开发工作空间>目录，
const resolveDevWorkspaceDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const baseDir = resolveDefaultAgentWorkspaceDir(env, os.homedir);
  const profile = normalizeOptionalLowercaseString(env.OPENCLAW_PROFILE);
  if (profile === "dev") {
    return baseDir;
  }
  return `${baseDir}-${DEV_AGENT_WORKSPACE_SUFFIX}`;
};

async function writeFileIfMissing(filePath: string, content: string) {
  try {
    await fs.promises.writeFile(filePath, content, {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "EEXIST") {
      throw err;
    }
  }
}

async function ensureDevWorkspace(dir: string) {
  const resolvedDir = resolveUserPath(dir);
  await fs.promises.mkdir(resolvedDir, { recursive: true });

  const [agents, soul, tools, identity, user] = await Promise.all([
    loadDevTemplate(
      "AGENTS.dev.md",
      `# AGENTS.md - OpenClaw Dev Workspace\n\nDefault dev workspace for openclaw gateway --dev.\n`,
    ),
    loadDevTemplate(
      "SOUL.dev.md",
      `# SOUL.md - Dev Persona\n\nProtocol droid for debugging and operations.\n`,
    ),
    loadDevTemplate(
      "TOOLS.dev.md",
      `# TOOLS.md - User Tool Notes (editable)\n\nAdd your local tool notes here.\n`,
    ),
    loadDevTemplate(
      "IDENTITY.dev.md",
      `# IDENTITY.md - Agent Identity\n\n- Name: ${DEV_IDENTITY_NAME}\n- Creature: protocol droid\n- Vibe: ${DEV_IDENTITY_THEME}\n- Emoji: ${DEV_IDENTITY_EMOJI}\n`,
    ),
    loadDevTemplate(
      "USER.dev.md",
      `# USER.md - User Profile\n\n- Name:\n- Preferred address:\n- Notes:\n`,
    ),
  ]);

  await writeFileIfMissing(path.join(resolvedDir, "AGENTS.md"), agents);
  await writeFileIfMissing(path.join(resolvedDir, "SOUL.md"), soul);
  await writeFileIfMissing(path.join(resolvedDir, "TOOLS.md"), tools);
  await writeFileIfMissing(path.join(resolvedDir, "IDENTITY.md"), identity);
  await writeFileIfMissing(path.join(resolvedDir, "USER.md"), user);
}

// 确保开发环境的配置文件存在，
// 如果不存在或者需要重置，则创建或覆盖配置文件，并确保开发工作空间准备就绪。
export async function ensureDevGatewayConfig(opts: { reset?: boolean }) {
  const workspace = resolveDevWorkspaceDir();
  if (opts.reset) {
    // 处理重置逻辑，调用 handleReset 函数来重置开发工作空间，
    await handleReset("full", workspace, defaultRuntime);
  }

  const io = createConfigIO();
  const configPath = io.configPath;
  const configExists = fs.existsSync(configPath);
  if (!opts.reset && configExists) {
    // 配置文件已经存在且不需要重置，直接返回。
    return;
  }

  await replaceConfigFile({
    nextConfig: {
      gateway: {
        mode: "local",
        bind: "loopback",
      },
      agents: {
        defaults: {
          workspace,
          skipBootstrap: true,
        },
        list: [
          {
            id: "dev",
            default: true,
            workspace,
            identity: {
              name: DEV_IDENTITY_NAME,
              theme: DEV_IDENTITY_THEME,
              emoji: DEV_IDENTITY_EMOJI,
            },
          },
        ],
      },
    },
    afterWrite: { mode: "auto" },
  });
  // 确保开发工作空间准备就绪。
  await ensureDevWorkspace(workspace);
  defaultRuntime.log(`Dev config ready: ${shortenHomePath(configPath)}`);
  defaultRuntime.log(`Dev workspace ready: ${shortenHomePath(resolveUserPath(workspace))}`);
}
