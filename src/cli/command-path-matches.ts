type StructuredCommandPathMatchRule = {
  pattern: readonly string[];
  exact?: boolean;
};

type CommandPathMatchRule = readonly string[] | StructuredCommandPathMatchRule;

type NormalizedCommandPathMatchRule = {
  pattern: readonly string[];
  exact: boolean;
};

function isStructuredCommandPathMatchRule(
  rule: CommandPathMatchRule,
): rule is StructuredCommandPathMatchRule {
  return !Array.isArray(rule);
}

function normalizeCommandPathMatchRule(rule: CommandPathMatchRule): NormalizedCommandPathMatchRule {
  if (!isStructuredCommandPathMatchRule(rule)) {
    return { pattern: rule, exact: false };
  }
  return { pattern: rule.pattern, exact: rule.exact ?? false };
}

// 匹配命令配置。
export function matchesCommandPath(
  commandPath: string[],
  pattern: readonly string[],
  params?: { exact?: boolean },
): boolean {
  if (pattern.some((segment, index) => commandPath[index] !== segment)) {
    // 如果命令路径的前缀不匹配模式，则返回 false。
    return false;
  }
  // 如果是精确匹配，则命令路径的长度必须与模式的长度相同；
  // 否则，命令路径可以有更多的段。
  return !params?.exact || commandPath.length === pattern.length;
}

export function matchesCommandPathRule(commandPath: string[], rule: CommandPathMatchRule): boolean {
  const normalizedRule = normalizeCommandPathMatchRule(rule);
  return matchesCommandPath(commandPath, normalizedRule.pattern, {
    exact: normalizedRule.exact,
  });
}

export function matchesAnyCommandPath(
  commandPath: string[],
  rules: readonly CommandPathMatchRule[],
): boolean {
  return rules.some((rule) => matchesCommandPathRule(commandPath, rule));
}
