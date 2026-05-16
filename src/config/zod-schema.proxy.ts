import { z } from "zod";
import { sensitive } from "./zod-schema.sensitive.js";

function isHttpProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:";
  } catch {
    return false;
  }
}

export const ProxyConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    proxyUrl: z
      .string() // 是一个字符串，
      .url() // 并且是一个有效的 URL，
      .refine(isHttpProxyUrl, {
        message: "proxyUrl must use http://",
      }) // 提示一个检查函数，确保 URL 使用 http 协议，
      .register(sensitive) // 注册为敏感数据，确保在日志和错误消息中被适当处理和隐藏，
      .optional(), // 可选字段，如果未提供，则默认为 undefined。
  })
  .strict() // 严格模式，确保没有未定义的字段被允许，
  .optional(); // 整个配置对象也是可选的，如果未提供，则默认为 undefined。

export type ProxyConfig = z.infer<typeof ProxyConfigSchema>; // 导出 ProxyConfig 类型， Zod schema 转换为 TypeScript 类型
