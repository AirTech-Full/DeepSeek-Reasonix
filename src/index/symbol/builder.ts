/** Walk project → extract symbols via tree-sitter → persist to SymbolStore. */

import { promises as fs } from "node:fs";
import path from "node:path";
import { grammarForPath } from "../../code-query/grammar-map.js";
import { extractSymbols } from "../../code-query/symbols.js";
import { type GitignoreLayer, ignoredByLayers, loadGitignoreAt } from "../../gitignore.js";
import {
  type IndexFilters,
  type ResolvedIndexConfig,
  compileFilters,
  defaultIndexConfig,
} from "../config.js";
import { type RawCallEdge, extractCallEdges } from "./edges.js";
import { resolveCallEdges } from "./resolver.js";
import { SYMBOL_INDEX_DIR, SymbolStore, openStore, qualifiedName, symbolId } from "./store.js";
import type { CallEdge, SymbolEntry } from "./types.js";

export interface BuildProgress {
  phase: "scan" | "extract" | "edges" | "resolve" | "done";
  filesScanned?: number;
  filesExtracted?: number;
  symbolsFound?: number;
  edgesFound?: number;
  edgesResolved?: number;
}

export interface BuildResult {
  filesScanned: number;
  filesExtracted: number;
  filesSkipped: number;
  symbolsFound: number;
  durationMs: number;
}

export interface SyncResult {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  symbolsUpdated: number;
  durationMs: number;
}

export interface BuildOptions {
  /** Override index config for file walking. */
  indexConfig?: ResolvedIndexConfig;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Progress callback. */
  onProgress?: (info: BuildProgress) => void;
}

/** Full (re)build of the symbol index from scratch. */
export async function buildSymbolIndex(
  root: string,
  opts: BuildOptions = {},
): Promise<BuildResult> {
  const t0 = Date.now();
  const indexDir = path.join(root, SYMBOL_INDEX_DIR);
  const filters: IndexFilters = compileFilters(opts.indexConfig ?? defaultIndexConfig());

  // Wipe and start fresh for full rebuilds
  const store = await openStore(indexDir);
  await store.wipe();

  let filesScanned = 0;
  let filesExtracted = 0;
  let filesSkipped = 0;
  let symbolsFound = 0;

  const rootIg = filters.respectGitignore ? await loadGitignoreAt(root) : null;
  const initialLayers: GitignoreLayer[] = rootIg ? [{ dirAbs: root, ig: rootIg }] : [];

  opts.onProgress?.({ phase: "scan", filesScanned: 0 });

  const allRawEdges: RawCallEdge[] = [];

  for await (const { abs, rel, layers } of walkSourceFiles(root, initialLayers, filters)) {
    throwIfAborted(opts.signal);
    filesScanned++;

    // Only process files with supported grammars
    if (!grammarForPath(rel)) {
      filesSkipped++;
      continue;
    }

    let source: string;
    try {
      source = await fs.readFile(abs, "utf8");
    } catch {
      filesSkipped++;
      continue;
    }

    // Skip binary-looking content
    if (source.indexOf("\0") !== -1) {
      filesSkipped++;
      continue;
    }

    let mtimeMs = 0;
    try {
      const stat = await fs.stat(abs);
      mtimeMs = stat.mtimeMs;
    } catch {
      mtimeMs = Date.now();
    }

    const symbols = await extractSymbols(rel, source);
    if (symbols.length === 0) {
      filesSkipped++;
      continue;
    }

    const entries: SymbolEntry[] = symbols.map((sym) => ({
      id: symbolId(rel, sym.name, sym.line),
      name: sym.name,
      qualifiedName: qualifiedName(rel, sym.name, sym.parent),
      filePath: rel,
      kind: sym.kind,
      startLine: sym.line,
      endLine: sym.endLine,
      startColumn: sym.column,
      endColumn: sym.endColumn,
      parent: sym.parent,
      signature: undefined,
      mtimeMs,
    }));

    await store.add(entries);
    filesExtracted++;
    symbolsFound += entries.length;

    // Extract call edges from this file
    const rawEdges = await extractCallEdges(rel, source);
    allRawEdges.push(...rawEdges);

    if (filesScanned % 100 === 0) {
      opts.onProgress?.({
        phase: "extract",
        filesScanned,
        filesExtracted,
        symbolsFound,
      });
    }
  }

  // Resolve all accumulated call edges
  opts.onProgress?.({
    phase: "edges",
    filesScanned,
    filesExtracted,
    symbolsFound,
    edgesFound: allRawEdges.length,
  });
  const { edges, result: resolutionResult } = resolveCallEdges(allRawEdges, store);
  await store.addEdges(edges);

  opts.onProgress?.({
    phase: "done",
    filesScanned,
    filesExtracted,
    symbolsFound,
    edgesFound: allRawEdges.length,
    edgesResolved: resolutionResult.resolved,
  });

  return {
    filesScanned,
    filesExtracted,
    filesSkipped,
    symbolsFound,
    durationMs: Date.now() - t0,
  };
}

/** Incremental update: re-extract changed files, remove deleted files. */
export async function syncSymbolIndex(
  root: string,
  opts: BuildOptions & { changedFiles?: string[] } = {},
): Promise<SyncResult> {
  const t0 = Date.now();
  const indexDir = path.join(root, SYMBOL_INDEX_DIR);
  const filters: IndexFilters = compileFilters(opts.indexConfig ?? defaultIndexConfig());
  const store = await openStore(indexDir);

  const lastMtimes = store.fileMtimes();
  const rootIg = filters.respectGitignore ? await loadGitignoreAt(root) : null;
  const initialLayers: GitignoreLayer[] = rootIg ? [{ dirAbs: root, ig: rootIg }] : [];

  let filesChecked = 0;
  let filesAdded = 0;
  let filesModified = 0;
  let filesRemoved = 0;
  let symbolsUpdated = 0;

  // If we have a specific changed-files list, scope to those
  const scoped = opts.changedFiles && opts.changedFiles.length > 0;

  if (scoped) {
    const changed = new Set(opts.changedFiles!);
    for (const rel of changed) {
      throwIfAborted(opts.signal);
      const abs = path.join(root, rel);
      filesChecked++;

      // File removed?
      try {
        await fs.access(abs);
      } catch {
        const removed = await store.remove([rel]);
        if (removed > 0) {
          filesRemoved++;
          symbolsUpdated += removed;
        }
        continue;
      }

      if (!grammarForPath(rel)) continue;

      let source: string;
      try {
        source = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (source.indexOf("\0") !== -1) continue;

      let mtimeMs = 0;
      try {
        const stat = await fs.stat(abs);
        mtimeMs = stat.mtimeMs;
      } catch {
        continue;
      }

      const last = lastMtimes.get(rel);
      if (last !== undefined && last === mtimeMs) continue;

      // Remove old entries for this file, then add new
      await store.remove([rel]);
      const symbols = await extractSymbols(rel, source);
      if (symbols.length === 0) continue;

      const entries: SymbolEntry[] = symbols.map((sym) => ({
        id: symbolId(rel, sym.name, sym.line),
        name: sym.name,
        qualifiedName: qualifiedName(rel, sym.name, sym.parent),
        filePath: rel,
        kind: sym.kind,
        startLine: sym.line,
        endLine: sym.endLine,
        startColumn: sym.column,
        endColumn: sym.endColumn,
        parent: sym.parent,
        signature: undefined,
        mtimeMs,
      }));
      await store.add(entries);

      if (last === undefined) filesAdded++;
      else filesModified++;
      symbolsUpdated += entries.length;
    }
  } else {
    // Full scan for changes
    const seen = new Set<string>();
    for await (const { abs, rel } of walkSourceFiles(root, initialLayers, filters)) {
      throwIfAborted(opts.signal);
      seen.add(rel);
      filesChecked++;

      if (!grammarForPath(rel)) continue;

      let mtimeMs = 0;
      try {
        const stat = await fs.stat(abs);
        mtimeMs = stat.mtimeMs;
      } catch {
        continue;
      }

      const last = lastMtimes.get(rel);
      if (last !== undefined && last === mtimeMs) continue;

      let source: string;
      try {
        source = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (source.indexOf("\0") !== -1) continue;

      await store.remove([rel]);
      const symbols = await extractSymbols(rel, source);
      if (symbols.length === 0) continue;

      const entries: SymbolEntry[] = symbols.map((sym) => ({
        id: symbolId(rel, sym.name, sym.line),
        name: sym.name,
        qualifiedName: qualifiedName(rel, sym.name, sym.parent),
        filePath: rel,
        kind: sym.kind,
        startLine: sym.line,
        endLine: sym.endLine,
        startColumn: sym.column,
        endColumn: sym.endColumn,
        parent: sym.parent,
        signature: undefined,
        mtimeMs,
      }));
      await store.add(entries);

      if (last === undefined) filesAdded++;
      else filesModified++;
      symbolsUpdated += entries.length;
    }

    // Remove files no longer on disk
    for (const oldPath of lastMtimes.keys()) {
      if (!seen.has(oldPath)) {
        const removed = await store.remove([oldPath]);
        if (removed > 0) {
          filesRemoved++;
          symbolsUpdated += removed;
        }
      }
    }
  }

  return {
    filesChecked,
    filesAdded,
    filesModified,
    filesRemoved,
    symbolsUpdated,
    durationMs: Date.now() - t0,
  };
}

interface WalkFrame {
  dir: string;
  layers: readonly GitignoreLayer[];
}

interface WalkEntry {
  abs: string;
  rel: string;
  layers: readonly GitignoreLayer[];
}

async function* walkSourceFiles(
  root: string,
  initialLayers: readonly GitignoreLayer[],
  filters: IndexFilters,
): AsyncGenerator<WalkEntry> {
  const stack: WalkFrame[] = [{ dir: root, layers: initialLayers }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const { dir, layers } = frame;

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const name = entry.name;
      const abs = path.join(dir, name);
      const rel = path.relative(root, abs).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (filters.dirSet.has(name)) continue;
        if (filters.respectGitignore && ignoredByLayers(layers, abs, true)) continue;
        if (filters.patternMatch(`${rel}/`) || filters.patternMatch(rel)) continue;
        const childLayers = filters.respectGitignore ? await extendLayers(layers, abs) : layers;
        stack.push({ dir: abs, layers: childLayers });
        continue;
      }

      if (!entry.isFile()) continue;
      if (filters.fileSet.has(name)) continue;
      const ext = path.extname(name).toLowerCase();
      if (filters.extSet.has(ext)) continue;
      if (filters.respectGitignore && ignoredByLayers(layers, abs, false)) continue;
      if (filters.patternMatch(rel)) continue;

      // Size gate
      try {
        const stat = await fs.stat(abs);
        if (stat.size > filters.maxFileBytes) continue;
      } catch {
        continue;
      }

      yield { abs, rel, layers };
    }
  }
}

async function extendLayers(
  layers: readonly GitignoreLayer[],
  dirAbs: string,
): Promise<readonly GitignoreLayer[]> {
  const ig = await loadGitignoreAt(dirAbs);
  return ig ? [...layers, { dirAbs, ig }] : layers;
}

export { SymbolWatcher, type WatchOptions } from "./watcher.js";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("symbol indexing aborted");
  }
}
