import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type DiskCache = {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
};

/**
 * One JSON file per key. `refresh` skips reads but still writes, so a refreshed run
 * leaves a warm cache behind.
 */
export function createDiskCache(dir: string, options: { refresh?: boolean } = {}): DiskCache {
  const fileFor = (key: string) => {
    const hash = createHash("sha256").update(key).digest("hex");
    return path.join(dir, hash.slice(0, 2), `${hash}.json`);
  };

  return {
    get(key) {
      if (options.refresh) return undefined;
      try {
        return JSON.parse(fs.readFileSync(fileFor(key), "utf8")).value;
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      const file = fileFor(key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ storedAt: new Date().toISOString(), value }));
      fs.renameSync(tmp, file);
    },
  };
}

export const NO_CACHE: DiskCache = { get: () => undefined, set: () => {} };
