import { readdir, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheCleanResult, CacheStat } from "@shared/types";

/**
 * C 盘缓存清理。
 *
 * 只碰这些明确的缓存目录，**不碰** settings.json / scenarios.json /
 * conn-history.json / Local Storage（里面存的是磁贴尺寸、语言这些用户状态）。
 */
const CACHE_DIRS = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "GrShaderCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "CachedData",
  "Crashpad",
  "blob_storage",
];

const ONEDAY = 24 * 60 * 60 * 1000;

/** 递归统计目录体积，顺带跳过被占用/无权限的条目。 */
async function walkSize(root: string, acc: CacheStat): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      await walkSize(p, acc);
      continue;
    }
    try {
      const s = await stat(p);
      acc.files += 1;
      acc.bytes += s.size;
    } catch {
      // 文件刚好被删掉/占用，忽略
    }
  }
}

export async function measureCache(userData: string): Promise<CacheStat> {
  const acc: CacheStat = { files: 0, bytes: 0 };
  for (const name of CACHE_DIRS) await walkSize(join(userData, name), acc);
  // 下载临时文件也算进来，用户才知道「释放了多少」
  for (const f of await staleTempFiles(0)) {
    try {
      const s = await stat(join(tmpdir(), f));
      acc.files += 1;
      acc.bytes += s.size;
    } catch {
      // ignore
    }
  }
  return acc;
}

/** `%TEMP%` 下我们自己的下载临时文件；days=0 表示全部。 */
async function staleTempFiles(days: number): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(tmpdir());
  } catch {
    return [];
  }
  const cutoff = Date.now() - days * ONEDAY;
  const out: string[] = [];
  for (const name of names) {
    if (!name.startsWith("adbpull-")) continue;
    try {
      const s = await stat(join(tmpdir(), name));
      if (days <= 0 || s.mtimeMs < cutoff) out.push(name);
    } catch {
      // ignore
    }
  }
  return out;
}

/** 删掉 `cutoff` 之前修改过的文件；目录被删空就一起移除。 */
async function purge(root: string, cutoff: number, acc: CacheCleanResult): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      await purge(p, cutoff, acc);
      continue;
    }
    try {
      const s = await stat(p);
      if (s.mtimeMs >= cutoff) continue;
      await unlink(p);
      acc.removed += 1;
      acc.freed += s.size;
    } catch {
      // 正在被 Chromium 占用，跳过
      acc.failed += 1;
    }
  }
  // 子目录删空了就一起删掉，免得留一堆空壳
  try {
    if ((await readdir(root)).length === 0) await rm(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * 清理 `days` 天前的缓存。
 * @param days 0 表示全部清理；1–365 按修改时间保留最近 N 天
 */
export async function cleanCache(userData: string, days: number): Promise<CacheCleanResult> {
  const d = Math.max(0, Math.min(365, Math.round(days)));
  // days=0 时 cutoff 放到未来，等价于「不看过期时间，全删」
  const cutoff = d === 0 ? Number.MAX_SAFE_INTEGER : Date.now() - d * ONEDAY;
  const acc: CacheCleanResult = { files: 0, bytes: 0, removed: 0, freed: 0, failed: 0 };
  for (const name of CACHE_DIRS) await purge(join(userData, name), cutoff, acc);

  for (const name of await staleTempFiles(d)) {
    try {
      await unlink(join(tmpdir(), name));
      acc.removed += 1;
      acc.failed += 0;
    } catch {
      acc.failed += 1;
    }
  }

  const after = await measureCache(userData);
  return { ...acc, files: after.files, bytes: after.bytes };
}
