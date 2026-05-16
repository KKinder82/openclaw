import type { OpenClawConfig } from "../config/types.openclaw.js";
import { trimToUndefined, type ExplicitGatewayAuth } from "./credentials.js";

function hasExplicitGatewayConnectionAuth(auth?: ExplicitGatewayAuth): boolean {
  return Boolean(trimToUndefined(auth?.token) || trimToUndefined(auth?.password));
}

export function canSkipGatewayConfigLoad(params: {
  config?: OpenClawConfig;
  urlOverride?: string;
  explicitAuth?: ExplicitGatewayAuth;
}): boolean {
  return (
    !params.config &&
    Boolean(trimToUndefined(params.urlOverride)) &&
    hasExplicitGatewayConnectionAuth(params.explicitAuth)
  );
}

// 判断 命令路径是 绕过网关配置加载的命令路径
export function isGatewayConfigBypassCommandPath(commandPath: readonly string[]): boolean {
  return commandPath[0] === "cron";
}
