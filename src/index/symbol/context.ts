/** Context builder: symbol search + call graph + source → one-shot code_context. */

import { promises as fs } from "node:fs";
import path from "node:path";
import { type TraversalHop, getCallees, getCallers } from "./graph.js";
import type { SymbolStore } from "./store.js";
import type { CallEdge, SymbolEntry } from "./types.js";

export interface ContextOptions {
  /** Max symbols to include in the result (default 15). */
  maxNodes?: number;
  /** Include source code snippets (default true). */
  includeCode?: boolean;
  /** Max characters per code snippet (default 1500). */
  maxCodeSize?: number;
  /** Call-graph expansion depth (default 1). */
  traversalDepth?: number;
  /** Max output characters (default 12000). */
  maxOutput?: number;
}

const DEFAULT_OPTIONS: Required<ContextOptions> = {
  maxNodes: 15,
  includeCode: true,
  maxCodeSize: 1500,
  traversalDepth: 1,
  maxOutput: 12000,
};

/** Extract likely symbol names from a natural-language query. */
function extractSymbolNames(query: string): string[] {
  const names = new Set<string>();

  // CamelCase: AuthService, loginUser
  for (const m of query.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]*)*|[a-z]+(?:[A-Z][a-z]*)+)\b/g)) {
    if (m[1] && m[1].length >= 3) names.add(m[1]!);
  }

  // snake_case: user_service
  for (const m of query.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi)) {
    if (m[1] && m[1].length >= 4) names.add(m[1]!);
  }

  // UPPER_CASE acronyms: HTTP, JSON, LRU
  for (const m of query.matchAll(/\b([A-Z]{2,})\b/g)) {
    names.add(m[1]!);
  }

  // dot.notation parts: "app.isPackaged" → ["app", "isPackaged"]
  for (const m of query.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)\b/g)) {
    for (const part of m[1]!.split(".")) {
      if (part.length >= 2) names.add(part);
    }
  }

  // Plain lowercase identifiers (≥3 chars)
  for (const m of query.matchAll(/\b([a-z][a-z0-9]{2,})\b/g)) {
    names.add(m[1]!);
  }

  // Filter common English words
  const commonWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "this",
    "that",
    "have",
    "been",
    "will",
    "would",
    "could",
    "should",
    "does",
    "done",
    "make",
    "made",
    "use",
    "used",
    "using",
    "work",
    "works",
    "find",
    "found",
    "show",
    "call",
    "called",
    "calling",
    "get",
    "set",
    "add",
    "all",
    "any",
    "how",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "not",
    "but",
    "are",
    "was",
    "were",
    "has",
    "had",
    "its",
    "can",
    "did",
    "may",
    "also",
    "into",
    "than",
    "then",
    "them",
    "each",
    "other",
    "some",
    "such",
    "only",
    "same",
    "about",
    "after",
    "before",
    "between",
    "through",
    "during",
    "without",
    "system",
    "need",
    "needs",
    "want",
    "like",
    "look",
    "data",
    "flow",
    "request",
    "response",
    "handle",
    "code",
    "change",
    "changes",
    "changed",
    "method",
    "class",
    "function",
    "return",
    "returns",
    "create",
    "read",
    "write",
    "start",
    "stop",
    "run",
    "running",
    "check",
    "take",
    "takes",
    "else",
    "just",
    "more",
    "most",
    "very",
    "being",
    "having",
    "doing",
  ]);

  return [...names].filter((n) => !commonWords.has(n.toLowerCase()));
}

export interface ContextResult {
  query: string;
  entryPoints: SymbolEntry[];
  relatedSymbols: SymbolEntry[];
  callRelationships: string[];
  codeBlocks: CodeBlock[];
  summary: string;
}

interface CodeBlock {
  symbolName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  kind: string;
  content: string;
}

/** Build context: extract names → search → call-graph expand → read source → format. */
export async function buildContext(
  query: string,
  store: SymbolStore,
  projectRoot: string,
  opts: ContextOptions = {},
): Promise<ContextResult> {
  const o = { ...DEFAULT_OPTIONS, ...opts };

  // Step 1: Extract symbol names from query
  const queryNames = extractSymbolNames(query);
  if (queryNames.length === 0) {
    return {
      query,
      entryPoints: [],
      relatedSymbols: [],
      callRelationships: [],
      codeBlocks: [],
      summary: "No recognizable symbol names found in the query.",
    };
  }

  // Step 2: Search the index for each extracted name
  const seen = new Set<string>();
  const entryPoints: SymbolEntry[] = [];
  for (const name of queryNames.slice(0, 10)) {
    const hits = store.search(name, { limit: 3 });
    for (const hit of hits) {
      if (!seen.has(hit.entry.id)) {
        seen.add(hit.entry.id);
        entryPoints.push(hit.entry);
      }
    }
    if (entryPoints.length >= o.maxNodes) break;
  }

  if (entryPoints.length === 0) {
    return {
      query,
      entryPoints: [],
      relatedSymbols: [],
      callRelationships: [],
      codeBlocks: [],
      summary: `No symbols matched the query terms: ${queryNames.slice(0, 5).join(", ")}.`,
    };
  }

  // Step 3: Expand via call graph from entry points
  const relatedMap = new Map<string, SymbolEntry>();
  const relationships: string[] = [];

  for (const ep of entryPoints.slice(0, 8)) {
    // Get callers
    const callers = getCallers(store, ep.id, o.traversalDepth);
    for (const hop of callers.hops) {
      if (!seen.has(hop.entry.id) && !relatedMap.has(hop.entry.id)) {
        relatedMap.set(hop.entry.id, hop.entry);
        seen.add(hop.entry.id);
      }
      if (hop.edge.resolved) {
        relationships.push(
          `${hop.entry.name} → ${ep.name} (${hop.entry.filePath}:${hop.edge.line})`,
        );
      }
    }

    // Get callees
    const callees = getCallees(store, ep.id, o.traversalDepth);
    for (const hop of callees.hops) {
      if (!seen.has(hop.entry.id) && !relatedMap.has(hop.entry.id)) {
        relatedMap.set(hop.entry.id, hop.entry);
        seen.add(hop.entry.id);
      }
      if (hop.edge.resolved) {
        relationships.push(`${ep.name} → ${hop.entry.name} (${ep.filePath}:${hop.edge.line})`);
      }
    }
  }

  const relatedSymbols = [...relatedMap.values()].slice(0, o.maxNodes - entryPoints.length);

  // Step 4: Read source for key symbols
  const codeBlocks: CodeBlock[] = [];
  if (o.includeCode) {
    const symbolsForCode = [...entryPoints.slice(0, 5), ...relatedSymbols.slice(0, 5)];
    const fileCache = new Map<string, string>();

    for (const sym of symbolsForCode) {
      try {
        let source = fileCache.get(sym.filePath);
        if (source === undefined) {
          const abs = path.join(projectRoot, sym.filePath);
          source = await fs.readFile(abs, "utf8");
          fileCache.set(sym.filePath, source);
        }
        const lines = source.split(/\r?\n/);
        const start = Math.max(0, sym.startLine - 1);
        const end = Math.min(lines.length, sym.endLine);
        const slice = lines.slice(start, end).join("\n");
        if (slice.length > o.maxCodeSize) {
          codeBlocks.push({
            symbolName: sym.name,
            filePath: sym.filePath,
            startLine: sym.startLine,
            endLine: sym.endLine,
            kind: sym.kind,
            content: `${slice.slice(0, o.maxCodeSize)}\n…(truncated)`,
          });
        } else {
          codeBlocks.push({
            symbolName: sym.name,
            filePath: sym.filePath,
            startLine: sym.startLine,
            endLine: sym.endLine,
            kind: sym.kind,
            content: slice,
          });
        }
      } catch {
        // File unreadable — skip
      }
    }
  }

  // Step 5: Build summary
  const summary = buildSummary(query, entryPoints, relatedSymbols, relationships);

  return {
    query,
    entryPoints,
    relatedSymbols,
    callRelationships: relationships,
    codeBlocks,
    summary,
  };
}

function buildSummary(
  query: string,
  entryPoints: SymbolEntry[],
  related: SymbolEntry[],
  relationships: string[],
): string {
  const parts: string[] = [];
  if (entryPoints.length > 0) {
    parts.push(`${entryPoints.length} entry point${entryPoints.length > 1 ? "s" : ""}`);
  }
  if (related.length > 0) {
    parts.push(`${related.length} related symbol${related.length > 1 ? "s" : ""}`);
  }
  if (relationships.length > 0) {
    parts.push(`${relationships.length} call relationship${relationships.length > 1 ? "s" : ""}`);
  }
  return parts.length > 0
    ? `Found: ${parts.join(", ")} for "${query}".`
    : `No results for "${query}".`;
}

/** Format context as markdown for model consumption. */
export function formatContextAsMarkdown(ctx: ContextResult): string {
  const lines: string[] = [];

  // Header
  lines.push(`## Context for: ${ctx.query}`);
  lines.push("");
  lines.push(ctx.summary);
  lines.push("");

  // Entry points
  if (ctx.entryPoints.length > 0) {
    lines.push("### Entry Points");
    lines.push("");
    for (const ep of ctx.entryPoints.slice(0, 10)) {
      const qual = ep.parent ? `${ep.parent}.${ep.name}` : ep.name;
      lines.push(`- \`${qual}\` (${ep.kind}) — ${ep.filePath}:${ep.startLine}`);
    }
    lines.push("");
  }

  // Related symbols
  if (ctx.relatedSymbols.length > 0) {
    lines.push("### Related Symbols");
    lines.push("");
    for (const sym of ctx.relatedSymbols.slice(0, 10)) {
      const qual = sym.parent ? `${sym.parent}.${sym.name}` : sym.name;
      lines.push(`- \`${qual}\` (${sym.kind}) — ${sym.filePath}:${sym.startLine}`);
    }
    lines.push("");
  }

  // Call relationships
  if (ctx.callRelationships.length > 0) {
    lines.push("### Call Relationships");
    lines.push("");
    const shown = ctx.callRelationships.slice(0, 15);
    for (const rel of shown) {
      lines.push(`- ${rel}`);
    }
    if (ctx.callRelationships.length > 15) {
      lines.push(`- …and ${ctx.callRelationships.length - 15} more`);
    }
    lines.push("");
  }

  // Code blocks
  if (ctx.codeBlocks.length > 0) {
    lines.push("### Code");
    lines.push("");
    for (const block of ctx.codeBlocks.slice(0, 8)) {
      const qual = block.symbolName;
      lines.push(
        `#### ${qual} (${block.kind}) — ${block.filePath}:${block.startLine}-${block.endLine}`,
      );
      lines.push("");
      lines.push("```");
      lines.push(block.content);
      lines.push("```");
      lines.push("");
    }
  }

  // Cap output
  const text = lines.join("\n");
  if (text.length > 12000) {
    return `${text.slice(0, 12000)}\n\n…(context output capped at 12K chars)`;
  }
  return text;
}
