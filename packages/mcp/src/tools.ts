import type { ToolAction } from './gate.js';
import type { McpToolResult } from './protocol.js';

/** Arguments as they arrive from a `tools/call`; validated by the tool itself. */
export type ToolArgs = Record<string, unknown>;

/** A JSON Schema object describing a tool's arguments. */
export type JsonSchema = Record<string, unknown>;

/** One tool a model can discover and invoke. */
export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * Derives the action the policy gate must approve before `run` is called.
   * Omit it for a read-only tool (a summary, a dry-run) — those are never
   * gated, because refusing a dry-run would only hide the policy from the model.
   */
  action?(args: ToolArgs): ToolAction;
  run(args: ToolArgs): Promise<McpToolResult> | McpToolResult;
}

/** The serialisable shape `tools/list` returns. */
export interface ToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
}

export function textResult(text: string, structuredContent?: unknown): McpToolResult {
  return structuredContent === undefined
    ? { content: [{ type: 'text', text }] }
    : { content: [{ type: 'text', text }], structuredContent };
}

export function errorResult(text: string, structuredContent?: unknown): McpToolResult {
  return structuredContent === undefined
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }], isError: true, structuredContent };
}

/** JSON replacer that renders `bigint` as a decimal string, never losing precision. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** A result whose text is the pretty-printed JSON of `structured`. */
export function jsonResult(structured: unknown): McpToolResult {
  return textResult(JSON.stringify(structured, jsonReplacer, 2), structured);
}

/** An ordered, name-unique set of tools. */
export class ToolRegistry {
  readonly #tools = new Map<string, McpTool>();

  constructor(tools: readonly McpTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: McpTool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`);
    }
    this.#tools.set(tool.name, tool);
  }

  get(name: string): McpTool | undefined {
    return this.#tools.get(name);
  }

  list(): McpTool[] {
    return [...this.#tools.values()];
  }

  descriptors(): ToolDescriptor[] {
    return this.list().map((tool) => {
      const descriptor: ToolDescriptor = {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      };
      if (tool.title !== undefined) descriptor.title = tool.title;
      return descriptor;
    });
  }
}
