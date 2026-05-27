/** Call-edge extraction from tree-sitter ASTs — raw (unresolved) caller→callee pairs. */

import type { Node } from "web-tree-sitter";
import { type GrammarName, getParser, grammarForPath } from "../../code-query/parser.js";

/** A raw call edge — callee is still a name string, not a symbol ID. */
export interface RawCallEdge {
  /** Name of the caller function/method (unqualified). */
  callerName: string;
  /** File path the caller lives in. */
  callerFile: string;
  /** Start line of the caller function. Used to disambiguate same-named callers. */
  callerLine: number;
  /** Name being called (the identifier text at the call site). */
  calleeName: string;
  /** File path where the call occurs. */
  file: string;
  /** 1-based line number of the call site. */
  line: number;
}

const CALL_PARENT_TYPES = new Set([
  "call_expression",
  "new_expression",
  "call",
  "method_invocation",
  "object_creation_expression",
]);

const MEMBER_EXPRESSION_TYPES = new Set([
  "member_expression",
  "attribute",
  "selector_expression",
  "field_expression",
]);

const FUNC_CONTAINER_TYPES = new Set([
  "function_declaration",
  "function_definition",
  "method_definition",
  "method_declaration",
  "arrow_function",
  "function_item",
  "constructor_declaration",
]);

const IDENTIFIER_TYPES = new Set([
  "identifier",
  "property_identifier",
  "type_identifier",
  "field_identifier",
]);

/** Extract call edges from a single source file — walks AST for call sites. */
export async function extractCallEdges(filePath: string, source: string): Promise<RawCallEdge[]> {
  const grammar = grammarForPath(filePath);
  if (!grammar) return [];
  const parser = await getParser(grammar);
  try {
    const tree = parser.parse(source);
    if (!tree) return [];
    try {
      const edges: RawCallEdge[] = [];
      const cursor = tree.rootNode.walk();
      try {
        let visitedChildren = false;
        while (true) {
          if (!visitedChildren) {
            const node = cursor.currentNode;
            if (CALL_PARENT_TYPES.has(node.type)) {
              const callee = extractCalleeName(node);
              if (callee) {
                const caller = findEnclosingFunction(node);
                edges.push({
                  callerName: caller.name,
                  callerFile: filePath,
                  callerLine: caller.line,
                  calleeName: callee,
                  file: filePath,
                  line: node.startPosition.row + 1,
                });
              }
            }
          }
          if (!visitedChildren && cursor.gotoFirstChild()) {
            visitedChildren = false;
            continue;
          }
          if (cursor.gotoNextSibling()) {
            visitedChildren = false;
            continue;
          }
          if (!cursor.gotoParent()) break;
          visitedChildren = true;
        }
      } finally {
        cursor.delete();
      }
      return edges;
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

/** Extract the function/method name from a call-expression node. */
function extractCalleeName(node: Node): string | null {
  // Direct call: foo()
  const funcField = firstField(node, ["function", "constructor"]);
  if (funcField && IDENTIFIER_TYPES.has(funcField.type)) {
    return funcField.text;
  }
  // Member call: obj.foo() — get the property name
  if (funcField && MEMBER_EXPRESSION_TYPES.has(funcField.type)) {
    const prop = firstField(funcField, ["property", "field", "attribute"]);
    if (prop && IDENTIFIER_TYPES.has(prop.type)) {
      return prop.text;
    }
  }
  return null;
}

/** Find the enclosing function/method that contains this node. */
function findEnclosingFunction(node: Node): { name: string; line: number } {
  let current: Node | null = node.parent;
  while (current) {
    if (FUNC_CONTAINER_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName("name");
      return {
        name: nameNode?.text ?? "<anonymous>",
        line: current.startPosition.row + 1,
      };
    }
    current = current.parent;
  }
  return { name: "<top-level>", line: 1 };
}

function firstField(parent: Node, fields: readonly string[]): Node | null {
  for (const field of fields) {
    const child = parent.childForFieldName(field);
    if (child) return child;
  }
  return null;
}
