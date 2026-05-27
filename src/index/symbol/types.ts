/** Symbol index types — persistent project-level symbol knowledge graph. */

import type { SymbolKind } from "../../code-query/symbols.js";

/** A single symbol stored in the project-level index. */
export interface SymbolEntry {
  /** Stable unique id — SHA-256 prefix of `filePath::qualifiedName`. */
  id: string;
  /** Simple name, e.g. "loginUser". */
  name: string;
  /** Fully qualified name, e.g. "src/auth/login.ts::AuthService.loginUser". */
  qualifiedName: string;
  /** Path relative to project root, forward slashes. */
  filePath: string;
  /** Symbol kind — function, class, method, interface, etc. */
  kind: SymbolKind;
  /** 1-based start line. */
  startLine: number;
  /** 1-based end line (inclusive). */
  endLine: number;
  /** 0-based start column. */
  startColumn: number;
  /** 0-based end column. */
  endColumn: number;
  /** Enclosing container name if nested (class name, namespace). */
  parent?: string;
  /** Function/method signature string if available. */
  signature?: string;
  /** File mtime at index time — used for change detection. */
  mtimeMs: number;
}

export interface SymbolSearchHit {
  entry: SymbolEntry;
  /** How the hit was scored (name exact > prefix > substring). */
  matchType: "exact" | "prefix" | "substring" | "fuzzy";
}

export interface SymbolSearchOptions {
  /** Filter by symbol kind. */
  kinds?: SymbolKind[];
  /** Maximum results (default 20). */
  limit?: number;
  /** Case-sensitive search (default false). */
  caseSensitive?: boolean;
}

/** A resolved call edge between two indexed symbols. */
export interface CallEdge {
  /** Symbol ID of the caller. */
  sourceId: string;
  /** Symbol ID of the callee, or null if unresolved. */
  targetId: string | null;
  /** Name text at the call site. */
  calleeName: string;
  /** File path where the call occurs. */
  file: string;
  /** 1-based line of the call site. */
  line: number;
  /** Whether the callee was resolved to a known symbol. */
  resolved: boolean;
}

export const SYMBOL_STORE_VERSION = 2;

export interface SymbolIndexMeta {
  version: number;
  /** Number of symbols in the index. */
  symbolCount: number;
  /** Number of files indexed. */
  fileCount: number;
  /** Number of call edges. */
  edgeCount: number;
  updatedAt: string;
}
