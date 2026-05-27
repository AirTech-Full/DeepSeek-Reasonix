/** File watcher — incremental sync via fs.watch + debounce (default 2000ms). */

import { type FSWatcher, watch } from "node:fs";
import path from "node:path";
import { grammarForPath } from "../../code-query/grammar-map.js";
import { type ResolvedIndexConfig, compileFilters, defaultIndexConfig } from "../config.js";
import { syncSymbolIndex } from "./builder.js";

export interface WatchOptions {
  /** Debounce window in ms (default 2000, clamped 100..60000). */
  debounceMs?: number;
  /** Override index config for file filtering. */
  indexConfig?: ResolvedIndexConfig;
  /** Called after each sync completes. */
  onSync?: (result: { filesChanged: number; durationMs: number }) => void;
  /** Called on watcher errors. */
  onError?: (err: Error) => void;
}

const DEFAULT_DEBOUNCE_MS = 2000;

export class SymbolWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFiles = new Set<string>();
  private debounceMs: number;
  private root: string;
  private onSync?: WatchOptions["onSync"];
  private onError?: WatchOptions["onError"];

  constructor(root: string, opts: WatchOptions = {}) {
    this.root = root;
    this.debounceMs = Math.max(100, Math.min(60000, opts.debounceMs ?? DEFAULT_DEBOUNCE_MS));
    this.onSync = opts.onSync;
    this.onError = opts.onError;
  }

  /** Start watching. Returns true if the watcher started successfully. */
  start(): boolean {
    if (this.watcher) return true;

    try {
      this.watcher = watch(this.root, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const rel = filename.toString().split(path.sep).join("/");

        // Only track source files with supported grammars
        if (!grammarForPath(rel)) return;

        // Skip hidden dirs and common excludes
        if (rel.startsWith(".") || rel.includes("/.")) return;
        if (rel.startsWith("node_modules/") || rel.includes("/node_modules/")) return;
        if (rel.startsWith("dist/") || rel.includes("/dist/")) return;

        this.pendingFiles.add(rel);
        this.scheduleSync();
      });

      this.watcher.on("error", (err) => {
        this.onError?.(err);
      });

      return true;
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  /** Stop watching. */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /** Whether the watcher is currently active. */
  isActive(): boolean {
    return this.watcher !== null;
  }

  /** Files that have changed since the last sync. */
  getPendingFiles(): string[] {
    return [...this.pendingFiles];
  }

  // -- internal ---------------------------------------------------------------

  private scheduleSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runSync();
    }, this.debounceMs);
  }

  private async runSync(): Promise<void> {
    const changed = [...this.pendingFiles];
    this.pendingFiles.clear();
    if (changed.length === 0) return;

    try {
      const t0 = Date.now();
      await syncSymbolIndex(this.root, { changedFiles: changed });
      this.onSync?.({
        filesChanged: changed.length,
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      // Put files back so they get retried on the next trigger
      for (const f of changed) this.pendingFiles.add(f);
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
