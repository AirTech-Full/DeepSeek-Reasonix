/** Resolve raw call edges to symbol IDs: same-file → same-dir → project-wide. */

import type { RawCallEdge } from "./edges.js";
import type { SymbolStore } from "./store.js";
import type { CallEdge } from "./types.js";

export interface ResolutionResult {
  total: number;
  resolved: number;
  unresolved: number;
}

/** Directory of a forward-slash path. "src/foo/bar.ts" → "src/foo". */
function dirOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(0, idx) : "";
}

/** Resolve raw edges: same-file → same-dir → project-wide callee matching. */
export function resolveCallEdges(
  rawEdges: RawCallEdge[],
  store: SymbolStore,
): { edges: CallEdge[]; result: ResolutionResult } {
  const edges: CallEdge[] = [];
  let resolved = 0;
  let unresolved = 0;

  for (const raw of rawEdges) {
    // Find caller symbol
    const caller = findSymbol(store, raw.callerName, raw.callerFile, raw.callerLine);
    const sourceId = caller?.id ?? raw.callerName;

    // Find callee symbol: same-file → same-dir → project-wide
    const callee = resolveCallee(store, raw.calleeName, raw.file);

    edges.push({
      sourceId,
      targetId: callee?.id ?? null,
      calleeName: raw.calleeName,
      file: raw.file,
      line: raw.line,
      resolved: callee !== null,
    });

    if (callee) resolved++;
    else unresolved++;
  }

  return { edges, result: { total: rawEdges.length, resolved, unresolved } };
}

/** Find a symbol by name in a specific file, nearest to a given line. */
function findSymbol(
  store: SymbolStore,
  name: string,
  filePath: string,
  line: number,
): ReturnType<(typeof store)["getById"]> {
  const candidates = store
    .getByFile(filePath)
    .filter((e) => e.name === name && e.startLine <= line && e.endLine >= line);
  if (candidates.length === 0) {
    // Fall back to any symbol with this name in the file
    const fileSyms = store.getByFile(filePath).filter((e) => e.name === name);
    if (fileSyms.length === 1) return fileSyms[0];
    if (fileSyms.length > 1) return fileSyms[0]; // ambiguous — pick first
    return undefined;
  }
  return candidates[0];
}

/** Resolve a callee name to a symbol: same-file → same-dir → project-wide. */
function resolveCallee(
  store: SymbolStore,
  calleeName: string,
  callFile: string,
): ReturnType<(typeof store)["getById"]> {
  // Step 1: same-file exact match
  const sameFile = store.getByFile(callFile).filter((e) => e.name === calleeName);
  if (sameFile.length === 1) return sameFile[0];

  // Step 2: same-directory
  const callDir = dirOf(callFile);
  const dirHits: typeof sameFile = [];
  for (const [filePath, entries] of store.fileEntries()) {
    if (filePath === callFile) continue;
    if (dirOf(filePath) !== callDir) continue;
    for (const e of entries) {
      if (e.name === calleeName) dirHits.push(e);
    }
  }
  if (dirHits.length === 1) return dirHits[0];

  // Step 3: project-wide exact match
  const projectHits: typeof sameFile = [];
  for (const [, entries] of store.fileEntries()) {
    for (const e of entries) {
      if (e.name === calleeName && e.filePath !== callFile) {
        projectHits.push(e);
      }
    }
  }
  if (projectHits.length === 1) return projectHits[0];

  // If multiple matches across the project, prefer same-directory
  if (dirHits.length > 0) return dirHits[0];

  return undefined;
}
