import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../utils.js";
import { applyMergePatch } from "./merge-patch.js";
import { isBlockedObjectKey } from "./prototype-keys.js";
import type { OpenClawConfig } from "./types.js";

const OPEN_DM_POLICY_ALLOW_FROM_RE =
  /^(?<policyPath>[a-z0-9_.-]+)\s*=\s*"open"\s+requires\s+(?<allowPath>[a-z0-9_.-]+)(?:\s+\(or\s+[a-z0-9_.-]+\))?\s+to include "\*"$/i;

// 管理配置中需要强制 unset 的路径列表，
const MANAGED_CONFIG_UNSET_PATHS = [["plugins", "installs"]] as const;

function cloneUnknown<T>(value: T): T {
  return structuredClone(value);
}

export function createMergePatch(base: unknown, target: unknown): unknown {
  if (!isRecord(base) || !isRecord(target)) {
    return cloneUnknown(target);
  }

  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
  for (const key of keys) {
    const hasBase = key in base;
    const hasTarget = key in target;
    if (!hasTarget) {
      patch[key] = null;
      continue;
    }
    const targetValue = target[key];
    if (!hasBase) {
      patch[key] = cloneUnknown(targetValue);
      continue;
    }
    const baseValue = base[key];
    if (isRecord(baseValue) && isRecord(targetValue)) {
      const childPatch = createMergePatch(baseValue, targetValue);
      if (isRecord(childPatch) && Object.keys(childPatch).length === 0) {
        continue;
      }
      patch[key] = childPatch;
      continue;
    }
    if (!isDeepStrictEqual(baseValue, targetValue)) {
      patch[key] = cloneUnknown(targetValue);
    }
  }
  return patch;
}

export function projectSourceOntoRuntimeShape(source: unknown, runtime: unknown): unknown {
  if (!isRecord(source) || !isRecord(runtime)) {
    return cloneUnknown(source);
  }

  const next: Record<string, unknown> = {};
  for (const [key, sourceValue] of Object.entries(source)) {
    if (!(key in runtime)) {
      next[key] = cloneUnknown(sourceValue);
      continue;
    }
    next[key] = projectSourceOntoRuntimeShape(sourceValue, runtime[key]);
  }
  return next;
}

function hasOwnIncludeKey(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "$include");
}

function collectIncludeOwnedPaths(value: unknown, path: string[] = []): string[][] {
  if (!isRecord(value)) {
    return [];
  }
  if (hasOwnIncludeKey(value)) {
    return [path];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    collectIncludeOwnedPaths(child, [...path, key]),
  );
}

function patchTouchesPath(patch: unknown, path: string[]): boolean {
  if (path.length === 0) {
    return isRecord(patch) ? Object.keys(patch).length > 0 : true;
  }
  if (!isRecord(patch)) {
    return true;
  }
  const [head, ...tail] = path;
  if (!Object.prototype.hasOwnProperty.call(patch, head)) {
    return false;
  }
  return patchTouchesPath(patch[head], tail);
}

function formatConfigPath(path: string[]): string {
  return path.length > 0 ? path.join(".") : "<root>";
}

function getPathValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function setPathValue(value: unknown, path: string[], nextValue: unknown): unknown {
  if (path.length === 0) {
    return cloneUnknown(nextValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  const [head, ...tail] = path;
  return {
    ...value,
    [head]: setPathValue(value[head], tail, nextValue),
  };
}

function pathStartsWith(path: string[], prefix: string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

function pathOverlapsAny(path: string[], candidates: readonly string[][] | undefined): boolean {
  return Boolean(
    candidates?.some(
      (candidate) => pathStartsWith(path, candidate) || pathStartsWith(candidate, path),
    ),
  );
}

function isIncludeOwnedPath(rootAuthoredConfig: unknown, path: string[]): boolean {
  return collectIncludeOwnedPaths(rootAuthoredConfig).some(
    (includePath) => pathStartsWith(path, includePath) || pathStartsWith(includePath, path),
  );
}

function setPathValueCreatingParents(value: unknown, path: string[], nextValue: unknown): unknown {
  if (path.length === 0) {
    return cloneUnknown(nextValue);
  }
  const [head, ...tail] = path;
  const record = isRecord(value) ? value : {};
  return {
    ...record,
    [head]: setPathValueCreatingParents(record[head], tail, nextValue),
  };
}

function preserveSourceValueAtPath(params: {
  persistedCandidate: unknown;
  sourceConfig: unknown;
  nextConfig: unknown;
  rootAuthoredConfig: unknown;
  unsetPaths?: readonly string[][];
  path: string[];
  sourceValue?: unknown;
}): unknown {
  if (pathOverlapsAny(params.path, params.unsetPaths)) {
    return params.persistedCandidate;
  }
  if (isIncludeOwnedPath(params.rootAuthoredConfig, params.path)) {
    return params.persistedCandidate;
  }
  if (getPathValue(params.nextConfig, params.path) !== undefined) {
    return params.persistedCandidate;
  }
  const sourceValue = params.sourceValue ?? getPathValue(params.sourceConfig, params.path);
  if (
    sourceValue === undefined ||
    getPathValue(params.persistedCandidate, params.path) !== undefined
  ) {
    return params.persistedCandidate;
  }
  return setPathValueCreatingParents(params.persistedCandidate, params.path, sourceValue);
}

function preserveAuthoredAgentParams(params: {
  persistedCandidate: unknown;
  sourceConfig: unknown;
  nextConfig: unknown;
  rootAuthoredConfig: unknown;
  unsetPaths?: readonly string[][];
}): unknown {
  const defaults = getPathValue(params.sourceConfig, ["agents", "defaults"]);
  if (!isRecord(defaults)) {
    return params.persistedCandidate;
  }

  let next = params.persistedCandidate;
  if (Object.prototype.hasOwnProperty.call(defaults, "params")) {
    next = preserveSourceValueAtPath({
      ...params,
      persistedCandidate: next,
      path: ["agents", "defaults", "params"],
      sourceValue: defaults.params,
    });
  }

  const models = defaults.models;
  if (!isRecord(models)) {
    return next;
  }
  for (const [modelId, modelEntry] of Object.entries(models)) {
    if (!isRecord(modelEntry) || !Object.prototype.hasOwnProperty.call(modelEntry, "params")) {
      continue;
    }
    const modelPath = ["agents", "defaults", "models", modelId];
    const paramsPath = [...modelPath, "params"];
    if (getPathValue(next, modelPath) === undefined) {
      next = preserveSourceValueAtPath({
        ...params,
        persistedCandidate: next,
        path: modelPath,
        sourceValue: modelEntry,
      });
      continue;
    }
    next = preserveSourceValueAtPath({
      ...params,
      persistedCandidate: next,
      path: paramsPath,
      sourceValue: modelEntry.params,
    });
  }
  return next;
}

function preserveUntouchedIncludes(params: {
  patch: unknown;
  rootAuthoredConfig: unknown;
  persistedCandidate: unknown;
}): unknown {
  let next = params.persistedCandidate;
  for (const includePath of collectIncludeOwnedPaths(params.rootAuthoredConfig)) {
    if (patchTouchesPath(params.patch, includePath)) {
      throw new Error(
        `Config write would flatten $include-owned config at ${formatConfigPath(
          includePath,
        )}; edit that include file directly or remove the $include first.`,
      );
    }
    next = setPathValue(next, includePath, getPathValue(params.rootAuthoredConfig, includePath));
  }
  return next;
}

export function resolvePersistCandidateForWrite(params: {
  runtimeConfig: unknown;
  sourceConfig: unknown;
  nextConfig: unknown;
  rootAuthoredConfig?: unknown;
  unsetPaths?: readonly string[][];
}): unknown {
  const patch = createMergePatch(params.runtimeConfig, params.nextConfig);
  const projectedSource = projectSourceOntoRuntimeShape(params.sourceConfig, params.runtimeConfig);
  const rootAuthoredConfig = params.rootAuthoredConfig ?? params.sourceConfig;
  const persisted = preserveUntouchedIncludes({
    patch,
    rootAuthoredConfig,
    persistedCandidate: applyMergePatch(projectedSource, patch),
  });
  const withSchema = preserveRootSchemaUri({
    rootAuthoredConfig,
    nextConfig: params.nextConfig,
    persistedCandidate: persisted,
  });
  return preserveAuthoredAgentParams({
    sourceConfig: params.sourceConfig,
    nextConfig: params.nextConfig,
    rootAuthoredConfig,
    persistedCandidate: withSchema,
    unsetPaths: params.unsetPaths,
  });
}

function readRootSchemaUri(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.$schema !== "string") {
    return undefined;
  }
  return value.$schema;
}

function hasOwnRootSchemaKey(value: unknown): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "$schema");
}

function preserveRootSchemaUri(params: {
  rootAuthoredConfig: unknown;
  nextConfig: unknown;
  persistedCandidate: unknown;
}): unknown {
  if (hasOwnRootSchemaKey(params.nextConfig)) {
    return params.persistedCandidate;
  }
  const sourceSchema = readRootSchemaUri(params.rootAuthoredConfig);
  if (sourceSchema === undefined || !isRecord(params.persistedCandidate)) {
    return params.persistedCandidate;
  }
  return {
    ...params.persistedCandidate,
    $schema: sourceSchema,
  };
}

export function formatConfigValidationFailure(pathLabel: string, issueMessage: string): string {
  const match = issueMessage.match(OPEN_DM_POLICY_ALLOW_FROM_RE);
  const policyPath = match?.groups?.policyPath?.trim();
  const allowPath = match?.groups?.allowPath?.trim();
  if (!policyPath || !allowPath) {
    return `Config validation failed: ${pathLabel}: ${issueMessage}`;
  }

  return [
    `Config validation failed: ${pathLabel}`,
    "",
    `Configuration mismatch: ${policyPath} is "open", but ${allowPath} does not include "*".`,
    "",
    "Fix with:",
    `  openclaw config set ${allowPath} '["*"]'`,
    "",
    "Or switch policy:",
    `  openclaw config set ${policyPath} "pairing"`,
  ].join("\n");
}

// 参数 raw 是数字返回 true, 否则返回 false。
function isNumericPathSegment(raw: string): boolean {
  return /^[0-9]+$/.test(raw);
}

function isWritePlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwnObjectKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

const WRITE_PRUNED_OBJECT = Symbol("write-pruned-object"); // 被修剪的

function coerceConfig(value: unknown): OpenClawConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as OpenClawConfig;
}

function unsetPathForWriteAt(
  value: unknown,
  pathSegments: string[],
  depth: number,
): { changed: boolean; value: unknown } {
  if (depth >= pathSegments.length) {
    // 如果 pathSegments 的深度已经超过了路径长度，说明已经到达目标位置，
    // 但由于 unset 操作需要删除该位置的值，因此返回一个特殊标记 WRITE_PRUNED_OBJECT 来指示调用者进行删除，而不是保留原值。
    return { changed: false, value };
  }
  const segment = pathSegments[depth]; // 当前路径段
  const isLeaf = depth === pathSegments.length - 1; // 最后一个路径段表示要 unset 的目标位置

  if (Array.isArray(value)) {
    // Value 是一个数组时，路径段必须是一个有效的数字索引，且在数组范围内，
    if (!isNumericPathSegment(segment)) {
      // 如果路径段不是一个数字索引，则无法 unset 数组中的元素，直接返回未修改的值。
      return { changed: false, value };
    }
    const index = Number.parseInt(segment, 10);
    if (!Number.isFinite(index) || index < 0 || index >= value.length) {
      // 如果路径段表示的索引无效或超出数组范围，则无法 unset 数组中的元素，直接返回未修改的值。
      return { changed: false, value };
    }
    if (isLeaf) {
      // 如果已经到达目标位置，直接从数组中删除该索引对应的元素，并返回修改后的数组。
      const next = value.slice(); // 创建一个新的数组副本，以保持不可变性。
      next.splice(index, 1); // 从数组中删除指定索引的元素。
      return { changed: true, value: next };
    }
    // 如果还没有到达目标位置，继续递归地 unset 子路径，并根据子路径的修改结果来决定是否需要更新当前数组。
    const child = unsetPathForWriteAt(value[index], pathSegments, depth + 1);
    if (!child.changed) {
      return { changed: false, value };
    }
    const next = value.slice();
    if (child.value === WRITE_PRUNED_OBJECT) {
      // 如果子路径被标记为 WRITE_PRUNED_OBJECT，说明子路径的值已经被删除了，因此需要从数组中删除该索引对应的元素。
      next.splice(index, 1);
    } else {
      next[index] = child.value;
    }
    return { changed: true, value: next };
  }

  if (
    isBlockedObjectKey(segment) ||
    !isWritePlainObject(value) ||
    !hasOwnObjectKey(value, segment)
  ) {
    return { changed: false, value };
  }
  if (isLeaf) {
    const next: Record<string, unknown> = { ...value };
    delete next[segment];
    return {
      changed: true,
      value: Object.keys(next).length === 0 ? WRITE_PRUNED_OBJECT : next,
    };
  }

  const child = unsetPathForWriteAt(value[segment], pathSegments, depth + 1);
  if (!child.changed) {
    return { changed: false, value };
  }
  const next: Record<string, unknown> = { ...value };
  if (child.value === WRITE_PRUNED_OBJECT) {
    delete next[segment];
  } else {
    next[segment] = child.value;
  }
  return {
    changed: true,
    value: Object.keys(next).length === 0 ? WRITE_PRUNED_OBJECT : next,
  };
}

export function unsetPathForWrite(
  root: OpenClawConfig,
  pathSegments: string[],
): { changed: boolean; next: OpenClawConfig } {
  if (pathSegments.length === 0) {
    // 如果路径为空，则表示不需要 unset 任何内容，直接返回原始配置。
    return { changed: false, next: root };
  }
  const result = unsetPathForWriteAt(root, pathSegments, 0);
  if (!result.changed) {
    // 如果没有任何修改，直接返回原始配置。
    return { changed: false, next: root };
  }
  if (result.value === WRITE_PRUNED_OBJECT) {
    return { changed: true, next: {} };
  }
  if (isWritePlainObject(result.value)) {
    return { changed: true, next: coerceConfig(result.value) };
  }
  return { changed: false, next: root };
}

export function applyUnsetPathsForWrite(
  root: OpenClawConfig,
  unsetPaths: readonly string[][] | undefined,
): OpenClawConfig {
  let next = root;
  for (const unsetPath of unsetPaths ?? []) {
    if (!Array.isArray(unsetPath) || unsetPath.length === 0) {
      // 如果 unsetPath 不是一个非空数组，则跳过该路径，不进行任何 unset 操作。
      continue;
    }
    const unsetResult = unsetPathForWrite(next, unsetPath);
    if (unsetResult.changed) {
      next = unsetResult.next;
    }
  }
  // 返回经过所有 unset 路径处理后的配置，如果没有任何修改，则返回原始配置。
  return next;
}

// 生成 unsetPaths的最终列表，
// 包括 MANAGED_CONFIG_UNSET_PATHS 中的路径以及调用者提供的 unsetPaths 中的路径，
// 但会去重和过滤掉无效的路径。
export function resolveManagedUnsetPathsForWrite(
  unsetPaths: readonly string[][] | undefined,
): string[][] {
  const next: string[][] = [];
  for (const managedPath of MANAGED_CONFIG_UNSET_PATHS) {
    next.push(Array.from(managedPath)); // Array.from(managedPath) 把 managedPath 转换成一个新的数组实例
  }
  for (const unsetPath of unsetPaths ?? []) {
    if (!Array.isArray(unsetPath) || unsetPath.length === 0) {
      // 如果 unsetPath 不是一个非空数组，则跳过该路径，不将其包含在最终的 unset 路径列表中。
      continue;
    }
    if (next.some((existing) => isDeepStrictEqual(existing, unsetPath))) {
      // isDeepStrictEqual 比较2个对象是否深度相等，
      continue;
    }
    // 加入
    next.push([...unsetPath]);
  }
  return next;
}

export function collectChangedPaths(
  base: unknown,
  target: unknown,
  path: string,
  output: Set<string>,
): void {
  if (Array.isArray(base) && Array.isArray(target)) {
    const max = Math.max(base.length, target.length);
    for (let index = 0; index < max; index += 1) {
      const childPath = path ? `${path}[${index}]` : `[${index}]`;
      if (index >= base.length || index >= target.length) {
        output.add(childPath);
        continue;
      }
      collectChangedPaths(base[index], target[index], childPath, output);
    }
    return;
  }
  if (isRecord(base) && isRecord(target)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      const hasBase = key in base;
      const hasTarget = key in target;
      if (!hasTarget || !hasBase) {
        output.add(childPath);
        continue;
      }
      collectChangedPaths(base[key], target[key], childPath, output);
    }
    return;
  }
  if (!isDeepStrictEqual(base, target)) {
    output.add(path);
  }
}

function parentPath(value: string): string {
  if (!value) {
    return "";
  }
  if (value.endsWith("]")) {
    const index = value.lastIndexOf("[");
    return index > 0 ? value.slice(0, index) : "";
  }
  const index = value.lastIndexOf(".");
  return index >= 0 ? value.slice(0, index) : "";
}

function isPathChanged(path: string, changedPaths: Set<string>): boolean {
  if (changedPaths.has(path)) {
    return true;
  }
  let current = parentPath(path);
  while (current) {
    if (changedPaths.has(current)) {
      return true;
    }
    current = parentPath(current);
  }
  return changedPaths.has("");
}

export function restoreEnvRefsFromMap(
  value: unknown,
  path: string,
  envRefMap: Map<string, string>,
  changedPaths: Set<string>,
): unknown {
  if (typeof value === "string") {
    if (!isPathChanged(path, changedPaths)) {
      const original = envRefMap.get(path);
      if (original !== undefined) {
        return original;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, index) => {
      const updated = restoreEnvRefsFromMap(item, `${path}[${index}]`, envRefMap, changedPaths);
      if (updated !== item) {
        changed = true;
      }
      return updated;
    });
    return changed ? next : value;
  }
  if (isRecord(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const updated = restoreEnvRefsFromMap(child, childPath, envRefMap, changedPaths);
      if (updated !== child) {
        changed = true;
      }
      next[key] = updated;
    }
    return changed ? next : value;
  }
  return value;
}

export function resolveWriteEnvSnapshotForPath(params: {
  actualConfigPath: string;
  expectedConfigPath?: string;
  envSnapshotForRestore?: Record<string, string | undefined>;
}): Record<string, string | undefined> | undefined {
  if (
    params.expectedConfigPath === undefined ||
    params.expectedConfigPath === params.actualConfigPath
  ) {
    return params.envSnapshotForRestore;
  }
  return undefined;
}
