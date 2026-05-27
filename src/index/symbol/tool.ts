/** Register symbol-graph tools: symbol_search, callers, callees, impact, code_context. */

import { existsSync } from "node:fs";
import path from "node:path";
import type { SymbolKind } from "../../code-query/symbols.js";
import type { ToolRegistry } from "../../tools.js";
import { buildContext, formatContextAsMarkdown } from "./context.js";
import { formatTraversal, getCallees, getCallers, getImpactRadius } from "./graph.js";
import { SYMBOL_INDEX_DIR, openStore, readIndexMeta } from "./store.js";
import type { SymbolSearchOptions } from "./types.js";

export interface SymbolToolOptions {
  root: string;
  defaultLimit?: number;
}

/** Register `symbol_search` if the index exists. Returns true on success. */
export async function registerSymbolSearchTool(
  registry: ToolRegistry,
  opts: SymbolToolOptions,
): Promise<boolean> {
  const indexDir = path.join(opts.root, SYMBOL_INDEX_DIR);
  const metaPath = path.join(indexDir, "index.meta.json");
  if (!existsSync(metaPath)) return false;

  const meta = await readIndexMeta(indexDir);
  if (!meta || meta.symbolCount === 0) return false;

  const defaultLimit = opts.defaultLimit ?? 20;

  registry.register({
    name: "symbol_search",
    description:
      "Search for symbols (functions, classes, methods, interfaces, etc.) by NAME across the ENTIRE project. Use this when you know WHAT a thing is called ('loginUser', 'AuthService', 'handleClick') but need to find WHERE it lives. Returns file:line locations, kind, and enclosing parent. Much faster than search_content for named code elements — no grep noise, no comments/strings false positives. Use search_content only for literal text patterns or content inside function bodies.",
    readOnly: true,
    parallelSafe: true,
    stormExempt: true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Symbol name or partial name (e.g., 'loginUser', 'authenticate', 'Router'). Case-insensitive by default.",
        },
        kind: {
          type: "string",
          description: "Filter by symbol kind.",
          enum: [
            "function",
            "class",
            "interface",
            "type",
            "enum",
            "method",
            "property",
            "namespace",
          ],
        },
        limit: {
          type: "integer",
          description: `Maximum results (default: ${defaultLimit}).`,
          default: defaultLimit,
        },
      },
      required: ["query"],
    },
    fn: async (args: { query: string; kind?: string; limit?: number }) => {
      const store = await openStore(indexDir);
      const searchOpts: SymbolSearchOptions = {
        limit: args.limit ?? defaultLimit,
        kinds: args.kind ? [args.kind as SymbolKind] : undefined,
      };
      const hits = store.search(args.query, searchOpts);

      if (hits.length === 0) {
        return `symbol_search("${args.query}"${args.kind ? `, kind: ${args.kind}` : ""}): no matches.`;
      }

      return formatHits(args.query, hits);
    },
  });

  return true;
}

/** Register callers/callees/impact graph tools. Needs edge data in the index. */
export function registerCallGraphTools(registry: ToolRegistry, indexDir: string): void {
  registry.register({
    name: "callers",
    description:
      "Find all functions/methods that CALL the given symbol. Returns file:line call sites grouped by file. Use to understand usage patterns and who depends on a symbol before changing it.",
    readOnly: true,
    parallelSafe: true,
    stormExempt: true,
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description:
            "Name of the function or method to find callers for (e.g., 'loginUser', 'authenticate').",
        },
        depth: {
          type: "integer",
          description: "How many levels of callers to traverse (default: 1).",
          default: 1,
        },
      },
      required: ["symbol"],
    },
    fn: async (args: { symbol: string; depth?: number }) => {
      const store = await openStore(indexDir);
      const hits = store.search(args.symbol, { limit: 1, kinds: ["function", "method"] });
      if (hits.length === 0) return `No function/method named "${args.symbol}" found.`;
      const result = getCallers(store, hits[0]!.entry.id, args.depth ?? 1);
      return formatTraversal(args.symbol, "callers", result, args.depth ?? 1);
    },
  });

  registry.register({
    name: "callees",
    description:
      "Find all functions/methods CALLED BY the given symbol. Returns file:line call targets grouped by file. Use to trace what a function depends on.",
    readOnly: true,
    parallelSafe: true,
    stormExempt: true,
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Name of the function or method to find callees for.",
        },
        depth: {
          type: "integer",
          description: "How many levels of callees to traverse (default: 1).",
          default: 1,
        },
      },
      required: ["symbol"],
    },
    fn: async (args: { symbol: string; depth?: number }) => {
      const store = await openStore(indexDir);
      const hits = store.search(args.symbol, { limit: 1, kinds: ["function", "method"] });
      if (hits.length === 0) return `No function/method named "${args.symbol}" found.`;
      const result = getCallees(store, hits[0]!.entry.id, args.depth ?? 1);
      return formatTraversal(args.symbol, "callees", result, args.depth ?? 1);
    },
  });

  registry.register({
    name: "impact",
    description:
      "Analyze the impact radius of changing a symbol — find ALL code (transitive callers) that could be affected. Returns caller chains up to the specified depth. Use BEFORE editing a shared utility to understand blast radius.",
    readOnly: true,
    parallelSafe: true,
    stormExempt: true,
    parameters: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "Name of the symbol to analyze impact for.",
        },
        depth: {
          type: "integer",
          description: "How many levels of transitive callers to traverse (default: 2).",
          default: 2,
        },
      },
      required: ["symbol"],
    },
    fn: async (args: { symbol: string; depth?: number }) => {
      const store = await openStore(indexDir);
      const hits = store.search(args.symbol, { limit: 1, kinds: ["function", "method"] });
      if (hits.length === 0) return `No function/method named "${args.symbol}" found.`;
      const result = getImpactRadius(store, hits[0]!.entry.id, args.depth ?? 2);
      return formatTraversal(args.symbol, "impact", result, args.depth ?? 2);
    },
  });
}

/** Register the code_context tool. Needs symbol + edge data in the index. */
function registerContextTool(registry: ToolRegistry, indexDir: string, root: string): void {
  registry.register({
    name: "code_context",
    description:
      "PRIMARY TOOL — call this FIRST for any 'how does X work?', architecture, or feature-context question. Combines symbol search + call graph + source extraction into ONE call. Returns entry points, related symbols, call relationships, and key code snippets. Usually sufficient to answer the question with zero further grep/read. For precise 'what calls X' or 'what does X call' drill-down, use callers/callees as follow-up.",
    readOnly: true,
    parallelSafe: true,
    stormExempt: true,
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Description of the task, bug, or feature to build context for (e.g., 'auth flow', 'how does query execution work', 'retry backoff logic').",
        },
        maxNodes: {
          type: "integer",
          description: "Maximum symbols to include (default: 15).",
          default: 15,
        },
        includeCode: {
          type: "boolean",
          description: "Include source code snippets (default: true).",
          default: true,
        },
      },
      required: ["task"],
    },
    fn: async (args: { task: string; maxNodes?: number; includeCode?: boolean }) => {
      const store = await openStore(indexDir);
      const ctx = await buildContext(args.task, store, root, {
        maxNodes: args.maxNodes ?? 15,
        includeCode: args.includeCode ?? true,
        traversalDepth: 1,
      });
      return formatContextAsMarkdown(ctx);
    },
  });
}

/** Silent bootstrap — register if index exists, else skip. */
export async function bootstrapSymbolSearch(
  registry: ToolRegistry,
  root: string,
  opts: Omit<SymbolToolOptions, "root"> = {},
): Promise<{ enabled: boolean }> {
  const indexDir = path.join(root, SYMBOL_INDEX_DIR);
  const enabled = await registerSymbolSearchTool(registry, { ...opts, root });
  if (enabled) {
    registerCallGraphTools(registry, indexDir);
    registerContextTool(registry, indexDir, root);
  }
  return { enabled };
}

function formatHits(
  query: string,
  hits: Array<{
    entry: {
      name: string;
      kind: string;
      filePath: string;
      startLine: number;
      parent?: string;
      signature?: string;
    };
    matchType: string;
  }>,
): string {
  const lines: string[] = [
    `symbol_search("${query}"): ${hits.length} result${hits.length !== 1 ? "s" : ""}`,
    "",
  ];

  // Group by file for compact output
  const byFile = new Map<string, typeof hits>();
  for (const h of hits) {
    const list = byFile.get(h.entry.filePath);
    if (list) list.push(h);
    else byFile.set(h.entry.filePath, [h]);
  }

  for (const [file, fileHits] of byFile) {
    const symbols = fileHits.map((h) => {
      const qual = h.entry.parent ? `${h.entry.parent}.${h.entry.name}` : h.entry.name;
      return `${qual}(${h.entry.kind}):${h.entry.startLine}`;
    });
    lines.push(`  ${file} — ${symbols.join(", ")}`);
  }

  return lines.join("\n");
}
