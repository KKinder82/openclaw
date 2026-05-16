import { isValueToken } from "../infra/cli-root-options.js";

// 解析根级选项（即全局选项）的值，支持两种格式：
// 1. --option=value
// 2. --option value
// 返回值 value 是解析出的选项值，如果没有值或者值无效，则返回 null；
// consumedNext 表示是否消费了下一个参数作为选项值。next 是值时，则为 True
export function takeCliRootOptionValue(
  raw: string,
  next: string | undefined,
): {
  value: string | null;
  consumedNext: boolean;
} {
  if (raw.includes("=")) {
    const [, value] = raw.split("=", 2);
    const trimmed = (value ?? "").trim();
    return { value: trimmed || null, consumedNext: false };
  }
  const consumedNext = isValueToken(next);
  const trimmed = consumedNext ? next!.trim() : "";
  return { value: trimmed || null, consumedNext };
}
