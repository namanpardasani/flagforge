import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseSnapshot } from "./parse.js";
import type { ConfigStorage, StoredConfig } from "./types.js";

/**
 * Keeps the last good config in a JSON file so a restart during a FlagForge outage still has flags.
 * The file can contain your targeting rules, so it is written readable by the owner only (0600).
 * Writes go to a temp file first and are renamed into place, so a crash never leaves half a file.
 */
export class FileStorage implements ConfigStorage {
  constructor(private readonly path: string) {}

  async load(): Promise<StoredConfig | null> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<StoredConfig>;
      const config = parseSnapshot(raw.config);
      return {
        ...(typeof raw.etag === "string" ? { etag: raw.etag } : {}),
        savedAt: typeof raw.savedAt === "number" ? raw.savedAt : 0,
        config,
      };
    } catch {
      return null; // missing, unreadable or corrupt: behave as if there is no cache
    }
  }

  async save(stored: StoredConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(stored), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
