/** Call-graph traversal — BFS callers/callees/impact over SymbolStore edges. */

import type { SymbolStore } from "./store.js";
import type { CallEdge, SymbolEntry } from "./types.js";

export interface TraversalHop {
  entry: SymbolEntry;
  edge: CallEdge;
}

export interface TraversalResult {
  hops: TraversalHop[];
  visited: Set<string>;
}

/** Find all symbols that call `symbolId`, up to `depth` levels (BFS incoming). */
export function getCallers(store: SymbolStore, symbolId: string, depth = 1): TraversalResult {
  const hops: TraversalHop[] = [];
  const visited = new Set<string>([symbolId]);
  let frontier = new Set<string>([symbolId]);

  for (let d = 0; d < depth; d++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const edge of store.edgesTo(id)) {
        if (visited.has(edge.sourceId)) continue;
        const entry = store.getById(edge.sourceId);
        if (!entry) continue;
        visited.add(edge.sourceId);
        next.add(edge.sourceId);
        hops.push({ entry, edge });
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }

  return { hops, visited };
}

/** Find all symbols called by `symbolId`, up to `depth` levels (BFS outgoing). */
export function getCallees(store: SymbolStore, symbolId: string, depth = 1): TraversalResult {
  const hops: TraversalHop[] = [];
  const visited = new Set<string>([symbolId]);
  let frontier = new Set<string>([symbolId]);

  for (let d = 0; d < depth; d++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const edge of store.edgesFrom(id)) {
        if (!edge.targetId || visited.has(edge.targetId)) continue;
        const entry = store.getById(edge.targetId);
        if (!entry) continue;
        visited.add(edge.targetId);
        next.add(edge.targetId);
        hops.push({ entry, edge });
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }

  return { hops, visited };
}

/** Impact radius: transitive callers of `symbolId` up to `depth` levels. */
export function getImpactRadius(store: SymbolStore, symbolId: string, depth = 2): TraversalResult {
  // Impact = callers, traversing incoming edges
  return getCallers(store, symbolId, depth);
}

/** Format traversal results for model consumption. */
export function formatTraversal(
  symbolName: string,
  direction: "callers" | "callees" | "impact",
  result: TraversalResult,
  depth: number,
): string {
  if (result.hops.length === 0) {
    return `No ${direction} found for "${symbolName}" up to depth ${depth}.`;
  }

  const lines: string[] = [
    `${direction} of "${symbolName}" (depth ${depth}, ${result.hops.length} hop${result.hops.length !== 1 ? "s" : ""}):`,
    "",
  ];

  // Group by file
  const byFile = new Map<string, TraversalHop[]>();
  for (const hop of result.hops) {
    const list = byFile.get(hop.entry.filePath);
    if (list) list.push(hop);
    else byFile.set(hop.entry.filePath, [hop]);
  }

  for (const [file, fileHops] of byFile) {
    const symbols = fileHops.map((h) => {
      const qual = h.entry.parent ? `${h.entry.parent}.${h.entry.name}` : h.entry.name;
      return `${qual}(${h.entry.kind}):${h.edge.line}`;
    });
    lines.push(`  ${file} — ${symbols.join(", ")}`);
  }

  return lines.join("\n");
}
