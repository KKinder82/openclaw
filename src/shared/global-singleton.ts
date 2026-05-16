// Safe for process-local caches and registries that can tolerate helper-based
// resolution. Do not use this for live mutable state that must survive split
// runtime chunks; keep those on a direct globalThis[Symbol.for(...)] lookup.
// 这个模块提供了一个安全的全局单例解析函数 `resolveGlobalSingleton`，
// 适用于进程级别的缓存和注册表，可以容忍基于 helper 的解析方式。
// 不要将其用于必须在分割的运行时块之间存活的实时可变状态；
// 对于那些状态，请直接使用 `globalThis[Symbol.for(...)]` 进行查找。
export function resolveGlobalSingleton<T>(key: symbol, create: () => T): T {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  if (Object.prototype.hasOwnProperty.call(globalStore, key)) {
    return globalStore[key] as T;
  }
  const created = create();
  globalStore[key] = created;
  return created;
}

export function resolveGlobalMap<TKey, TValue>(key: symbol): Map<TKey, TValue> {
  return resolveGlobalSingleton(key, () => new Map<TKey, TValue>());
}
