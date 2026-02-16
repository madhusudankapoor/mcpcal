import { z } from "zod";

/**
 * Canonical tool names exposed by the MCP calculator server.
 *
 * Keeping this list central avoids string drift across:
 * - MCP server tool registration
 * - backend request validation
 * - UI action mapping
 */
export const TOOL_NAMES = ["add", "subtract", "multiply", "divide"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Shared JSON Schema type for calculator tool input.
 *
 * Every calculator tool accepts the same payload shape:
 * { a: number, b: number }
 */
export interface CalculatorToolSchema {
  type                 : "object";
  properties           : {
    a                  : { type: "number"; description: string };
    b                  : { type: "number"; description: string };
  };
  required             : ["a", "b"];
  additionalProperties : false;
}

/**
 * Tool metadata returned by MCP listTools() and exposed to the browser.
 */
export interface CalculatorToolDefinition {
  name        : ToolName;
  description : string;
  inputSchema : CalculatorToolSchema;
}

/**
 * Shared schema object reused by every tool definition.
 */
export const toolInputSchema: CalculatorToolSchema = {
  type: "object",
  properties: {
    a: { type: "number", description: "First number" },
    b: { type: "number", description: "Second number" }
  },
  required: ["a", "b"],
  additionalProperties: false
};

/**
 * MCP tool catalogue advertised by the calculator server.
 */
export const calculatorTools: CalculatorToolDefinition[] = [
  {
    name: "add",
    description: "Add two numbers together",
    inputSchema: toolInputSchema
  },
  {
    name: "subtract",
    description: "Subtract the second number from the first number",
    inputSchema: toolInputSchema
  },
  {
    name: "multiply",
    description: "Multiply two numbers together",
    inputSchema: toolInputSchema
  },
  {
    name: "divide",
    description: "Divide the first number by the second number",
    inputSchema: toolInputSchema
  }
];

/**
 * Runtime-safe validator for tool names received across HTTP/MCP boundaries.
 */
export const ToolNameSchema = z.enum(TOOL_NAMES);

/**
 * Runtime-safe validator for tool arguments.
 *
 * NOTE:
 * TypeScript types disappear at runtime, so we still validate values with Zod.
 */
export const ToolArgsSchema = z.object({
  a: z.number().finite(),
  b: z.number().finite()
});

export type ToolArgs = z.infer<typeof ToolArgsSchema>;

/**
 * HTTP request contract for POST /calculate.
 */
export const CalculateRequestSchema = z.object({
  tool: ToolNameSchema,
  args: ToolArgsSchema
});

export type CalculateRequest = z.infer<typeof CalculateRequestSchema>;

/**
 * Browser-facing success response.
 */
export interface CalculateSuccessResponse {
  result     : number;
  expression : string;
}

/**
 * Browser-facing error response.
 */
export interface ErrorResponse {
  error    : string;
  details? : string;
}

/**
 * Browser-facing response for GET /tools.
 */
export interface ToolListResponse {
  tools : CalculatorToolDefinition[];
}

/**
 * Typed payload encoded into MCP tool response text for success.
 */
export interface ToolExecutionSuccessPayload {
  ok      : true;
  result  : number;
}

/**
 * Typed payload encoded into MCP tool response text for failure.
 */
export interface ToolExecutionErrorPayload {
  ok      : false;
  error   : string;
  details?: string;
}

export type ToolExecutionPayload = ToolExecutionSuccessPayload | ToolExecutionErrorPayload;

/**
 * Learning-console trace levels.
 */
export type TraceLevel = "INFO" | "ERROR";

/**
 * Learning-console source components.
 */
export type TraceComponent = "ui" | "client-backend" | "mcp-calculator-server" | "mcp-protocol";

/**
 * One explanatory trace line rendered in the UI learning console.
 */
export interface McpConsoleEvent {
  id           : number;
  ts           : string;
  level        : TraceLevel;
  component    : TraceComponent;
  event        : string;
  summary      : string;
  explanation  : string;
  data?        : Record<string, unknown>;
}

/**
 * HTTP payload returned by GET /mcp-events.
 */
export interface McpConsoleEventsResponse {
  events : McpConsoleEvent[];
}
