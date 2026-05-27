/** JSONL append-only symbol store + in-memory lookup (≤50K symbols). */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SymbolKind } from "../../code-query/symbols.js";
import type {
  CallEdge,
  SymbolEntry,
  SymbolIndexMeta,
  SymbolSearchHit,
  SymbolSearchOptions,
} from "./types.js";
import { SYMBOL_STORE_VERSION } from "./types.js";

export const SYMBOL_INDEX_DIR = ".reasonix/symbols";

const META_FILE = "index.meta.json";
const DATA_FILE = "index.jsonl";
const EDGES_FILE = "edges.jsonl";

/** Stable symbol id: first 12 hex chars of SHA-256(filePath::name@line). */
export function symbolId(filePath: string, name: string, line: number): string {
  const raw = `${filePath}::${name}@${line}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/** Qualified name: filePath::Parent.name for nested symbols, filePath::name otherwise. */
export function qualifiedName(filePath: string, name: string, parent?: string): string {
  const scope = parent ? `${parent}.` : "";
  return `${filePath}::${scope}${name}`;
}

export class SymbolStore {
  private entries: SymbolEntry[] = [];
  private byId = new Map<string, SymbolEntry>();
  private byFile = new Map<string, SymbolEntry[]>();
  private byKind = new Map<SymbolKind, SymbolEntry[]>();
  /** Lowercase name → entries for case-insensitive search. */
  private byName = new Map<string, SymbolEntry[]>();
  /** Call edges — keyed by source and target. */
  private edges: CallEdge[] = [];
  private edgesBySource = new Map<string, CallEdge[]>();
  private edgesByTarget = new Map<string, CallEdge[]>();

  constructor(public readonly indexDir: string) {}

  // -- accessors --------------------------------------------------------------

  get size(): number {
    return this.entries.length;
  }

  get all(): readonly SymbolEntry[] {
    return this.entries;
  }

  /** File paths → latest mtime, for change detection. */
  fileMtimes(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [p, group] of this.byFile) {
      const first = group[0];
      if (first) out.set(p, first.mtimeMs);
    }
    return out;
  }

  // -- mutation ---------------------------------------------------------------

  async add(entries: readonly SymbolEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const lines: string[] = [];
    for (const e of entries) {
      this.entries.push(e);
      this.byId.set(e.id, e);
      // byFile
      const flist = this.byFile.get(e.filePath);
      if (flist) flist.push(e);
      else this.byFile.set(e.filePath, [e]);
      // byKind
      const klist = this.byKind.get(e.kind);
      if (klist) klist.push(e);
      else this.byKind.set(e.kind, [e]);
      // byName
      const lower = e.name.toLowerCase();
      const nlist = this.byName.get(lower);
      if (nlist) nlist.push(e);
      else this.byName.set(lower, [e]);
      lines.push(serializeEntry(e));
    }
    await fs.mkdir(this.indexDir, { recursive: true });
    await fs.appendFile(path.join(this.indexDir, DATA_FILE), `${lines.join("\n")}\n`, "utf8");
    await this.writeMeta();
  }

  /** Remove all symbols belonging to the given file paths. Returns count removed. */
  async remove(filePaths: readonly string[]): Promise<number> {
    if (filePaths.length === 0) return 0;
    const drop = new Set(filePaths);
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !drop.has(e.filePath));
    for (const p of filePaths) this.byFile.delete(p);
    // Rebuild derived indexes — cheaper than per-entry delete for bulk operations
    this.rebuildDerived();
    const removed = before - this.entries.length;
    if (removed > 0) await this.flush();
    return removed;
  }

  // -- search -----------------------------------------------------------------

  getById(id: string): SymbolEntry | undefined {
    return this.byId.get(id);
  }

  getByFile(filePath: string): SymbolEntry[] {
    return this.byFile.get(filePath) ?? [];
  }

  getByKind(kind: SymbolKind): SymbolEntry[] {
    return this.byKind.get(kind) ?? [];
  }

  /** Search by name. exact > prefix > substring, deduped by id. */
  search(query: string, opts: SymbolSearchOptions = {}): SymbolSearchHit[] {
    const limit = opts.limit ?? 20;
    const kinds = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null;
    const q = opts.caseSensitive ? query : query.toLowerCase();

    const exact: SymbolSearchHit[] = [];
    const prefix: SymbolSearchHit[] = [];
    const substring: SymbolSearchHit[] = [];
    const seen = new Set<string>();

    // Walk the name index
    for (const [lower, entries] of this.byName) {
      if (q.length === 0) break;
      // Fast path: if query doesn't appear at all in this name, skip
      const idx = lower.indexOf(q);
      if (idx === -1) continue;
      for (const e of entries) {
        if (seen.has(e.id)) continue;
        if (kinds && !kinds.has(e.kind)) continue;
        seen.add(e.id);
        const nameLower = opts.caseSensitive ? e.name : e.name.toLowerCase();
        if (nameLower === q) {
          exact.push({ entry: e, matchType: "exact" });
        } else if (nameLower.startsWith(q)) {
          prefix.push({ entry: e, matchType: "prefix" });
        } else {
          substring.push({ entry: e, matchType: "substring" });
        }
      }
    }

    // Merge: exact first, then prefix, then substring. Sort each bucket by name.
    const sortByName = (a: SymbolSearchHit, b: SymbolSearchHit) =>
      a.entry.name.localeCompare(b.entry.name);
    exact.sort(sortByName);
    prefix.sort(sortByName);
    substring.sort(sortByName);

    const merged = [...exact, ...prefix, ...substring];
    return merged.slice(0, limit);
  }

  /** All distinct file paths in the index. */
  filePaths(): string[] {
    return [...this.byFile.keys()].sort();
  }

  /** Iterate all entries grouped by file path. */
  fileEntries(): IterableIterator<[string, SymbolEntry[]]> {
    return this.byFile.entries();
  }

  /** All call edges. */
  getEdges(): CallEdge[] {
    return this.edges;
  }

  /** Edges originating from a symbol. */
  edgesFrom(sourceId: string): CallEdge[] {
    return this.edgesBySource.get(sourceId) ?? [];
  }

  /** Edges targeting a symbol. */
  edgesTo(targetId: string): CallEdge[] {
    return this.edgesByTarget.get(targetId) ?? [];
  }

  /** Add resolved call edges and persist. */
  async addEdges(newEdges: CallEdge[]): Promise<void> {
    if (newEdges.length === 0) return;
    const lines: string[] = [];
    for (const e of newEdges) {
      this.edges.push(e);
      const slist = this.edgesBySource.get(e.sourceId);
      if (slist) slist.push(e);
      else this.edgesBySource.set(e.sourceId, [e]);
      if (e.targetId) {
        const tlist = this.edgesByTarget.get(e.targetId);
        if (tlist) tlist.push(e);
        else this.edgesByTarget.set(e.targetId, [e]);
      }
      lines.push(serializeEdge(e));
    }
    await fs.mkdir(this.indexDir, { recursive: true });
    await fs.appendFile(path.join(this.indexDir, EDGES_FILE), `${lines.join("\n")}\n`, "utf8");
    await this.writeMeta();
  }

  /** Remove edges attached to symbols in the given files. */
  async removeEdgesForFiles(filePaths: readonly string[]): Promise<void> {
    if (filePaths.length === 0) return;
    const drop = new Set(filePaths);
    this.edges = this.edges.filter((e) => {
      if (drop.has(e.file)) return false;
      // Also drop if call site file is in the set
      return true;
    });
    this.rebuildEdgeIndexes();
    await this.flushEdges();
  }

  // -- persistence ------------------------------------------------------------

  private async flush(): Promise<void> {
    await fs.mkdir(this.indexDir, { recursive: true });
    const tmp = path.join(this.indexDir, `${DATA_FILE}.tmp`);
    const final = path.join(this.indexDir, DATA_FILE);
    const lines = this.entries.map(serializeEntry).join("\n");
    await fs.writeFile(tmp, lines.length > 0 ? `${lines}\n` : "", "utf8");
    await fs.rename(tmp, final);
    await this.writeMeta();
  }

  private async writeMeta(): Promise<void> {
    const fileCount = this.byFile.size;
    const meta: SymbolIndexMeta = {
      version: SYMBOL_STORE_VERSION,
      symbolCount: this.entries.length,
      fileCount,
      edgeCount: this.edges.length,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(this.indexDir, META_FILE),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf8",
    );
  }

  async wipe(): Promise<void> {
    this.entries = [];
    this.byId.clear();
    this.byFile.clear();
    this.byKind.clear();
    this.byName.clear();
    this.edges = [];
    this.edgesBySource.clear();
    this.edgesByTarget.clear();
    const dataPath = path.join(this.indexDir, DATA_FILE);
    const edgesPath = path.join(this.indexDir, EDGES_FILE);
    const metaPath = path.join(this.indexDir, META_FILE);
    await fs.rm(dataPath, { force: true });
    await fs.rm(edgesPath, { force: true });
    await fs.rm(metaPath, { force: true });
  }

  private async flushEdges(): Promise<void> {
    await fs.mkdir(this.indexDir, { recursive: true });
    const tmp = path.join(this.indexDir, `${EDGES_FILE}.tmp`);
    const final = path.join(this.indexDir, EDGES_FILE);
    const lines = this.edges.map(serializeEdge).join("\n");
    await fs.writeFile(tmp, lines.length > 0 ? `${lines}\n` : "", "utf8");
    await fs.rename(tmp, final);
  }

  private rebuildEdgeIndexes(): void {
    this.edgesBySource.clear();
    this.edgesByTarget.clear();
    for (const e of this.edges) {
      const slist = this.edgesBySource.get(e.sourceId);
      if (slist) slist.push(e);
      else this.edgesBySource.set(e.sourceId, [e]);
      if (e.targetId) {
        const tlist = this.edgesByTarget.get(e.targetId);
        if (tlist) tlist.push(e);
        else this.edgesByTarget.set(e.targetId, [e]);
      }
    }
  }

  // -- internal ---------------------------------------------------------------

  private rebuildDerived(): void {
    this.byId.clear();
    this.byFile.clear();
    this.byKind.clear();
    this.byName.clear();
    for (const e of this.entries) {
      this.byId.set(e.id, e);
      const flist = this.byFile.get(e.filePath);
      if (flist) flist.push(e);
      else this.byFile.set(e.filePath, [e]);
      const klist = this.byKind.get(e.kind);
      if (klist) klist.push(e);
      else this.byKind.set(e.kind, [e]);
      const lower = e.name.toLowerCase();
      const nlist = this.byName.get(lower);
      if (nlist) nlist.push(e);
      else this.byName.set(lower, [e]);
    }
  }
}

export async function openStore(indexDir: string): Promise<SymbolStore> {
  const store = new SymbolStore(indexDir);
  const dataPath = path.join(indexDir, DATA_FILE);

  let raw: string;
  try {
    raw = await fs.readFile(dataPath, "utf8");
  } catch {
    return store;
  }
  const entries: SymbolEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      entries.push(deserializeEntry(line));
    } catch {
      /* tolerate malformed line */
    }
  }
  // Bulk-add via internal method to avoid N individual appendFile calls
  if (entries.length > 0) {
    (store as unknown as { entries: SymbolEntry[] }).entries = entries;
    (store as unknown as Record<string, unknown>).rebuildDerived =
      store["rebuildDerived" as keyof typeof store];
    (store as unknown as { rebuildDerived: () => void }).rebuildDerived();
  }

  // Load edges
  const edgesPath = path.join(indexDir, EDGES_FILE);
  try {
    const edgeRaw = await fs.readFile(edgesPath, "utf8");
    const edges: CallEdge[] = [];
    for (const line of edgeRaw.split("\n")) {
      if (line.length === 0) continue;
      try {
        edges.push(deserializeEdge(line));
      } catch {
        /* tolerate malformed line */
      }
    }
    if (edges.length > 0) {
      (store as unknown as { edges: CallEdge[] }).edges = edges;
      const s = store as unknown as { rebuildEdgeIndexes: () => void };
      s.rebuildEdgeIndexes();
    }
  } catch {
    /* no edges file yet — fine */
  }

  return store;
}

export async function readIndexMeta(indexDir: string): Promise<SymbolIndexMeta | null> {
  try {
    const raw = await fs.readFile(path.join(indexDir, META_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<SymbolIndexMeta>;
    return {
      version: typeof parsed.version === "number" ? parsed.version : SYMBOL_STORE_VERSION,
      symbolCount: typeof parsed.symbolCount === "number" ? parsed.symbolCount : 0,
      fileCount: typeof parsed.fileCount === "number" ? parsed.fileCount : 0,
      edgeCount: typeof parsed.edgeCount === "number" ? parsed.edgeCount : 0,
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function serializeEntry(e: SymbolEntry): string {
  return JSON.stringify({
    id: e.id,
    n: e.name,
    q: e.qualifiedName,
    f: e.filePath,
    k: e.kind,
    sl: e.startLine,
    el: e.endLine,
    sc: e.startColumn,
    ec: e.endColumn,
    p: e.parent ?? null,
    sig: e.signature ?? null,
    mt: e.mtimeMs,
  });
}

function serializeEdge(e: CallEdge): string {
  return JSON.stringify({
    s: e.sourceId,
    t: e.targetId,
    cn: e.calleeName,
    f: e.file,
    l: e.line,
    r: e.resolved,
  });
}

function deserializeEdge(line: string): CallEdge {
  const r = JSON.parse(line) as {
    s: string;
    t: string | null;
    cn: string;
    f: string;
    l: number;
    r: boolean;
  };
  return {
    sourceId: r.s,
    targetId: r.t,
    calleeName: r.cn,
    file: r.f,
    line: r.l,
    resolved: r.r,
  };
}

function deserializeEntry(line: string): SymbolEntry {
  const r = JSON.parse(line) as {
    id: string;
    n: string;
    q: string;
    f: string;
    k: SymbolKind;
    sl: number;
    el: number;
    sc: number;
    ec: number;
    p: string | null;
    sig: string | null;
    mt: number;
  };
  return {
    id: r.id,
    name: r.n,
    qualifiedName: r.q,
    filePath: r.f,
    kind: r.k,
    startLine: r.sl,
    endLine: r.el,
    startColumn: r.sc,
    endColumn: r.ec,
    parent: r.p ?? undefined,
    signature: r.sig ?? undefined,
    mtimeMs: r.mt,
  };
}
