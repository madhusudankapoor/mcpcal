import { z } from "zod";

export const TOOL_NAMES = ["add", "subtract", "multiply", "divide"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface CalculatorToolSchema {
  type: "object";
  properties: {
    a: { type: "number"; description: string };
    b: { type: "number"; description: string };
  };
  required: ["a", "b"];
  additionalProperties: false;
}

export interface CalculatorToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: CalculatorToolSchema;
}

export const toolInputSchema: CalculatorToolSchema = {
  type: "object",
  properties: {
    a: { type: "number", description: "First number" },
    b: { type: "number", description: "Second number" }
  },
  required: ["a", "b"],
  additionalProperties: false
};

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

export const ToolNameSchema = z.enum(TOOL_NAMES);
export const ToolArgsSchema = z.object({
  a: z.number().finite(),
  b: z.number().finite()
});

export type ToolArgs = z.infer<typeof ToolArgsSchema>;

export const CalculateRequestSchema = z.object({
  tool: ToolNameSchema,
  args: ToolArgsSchema
});

export type CalculateRequest = z.infer<typeof CalculateRequestSchema>;

export interface CalculateSuccessResponse {
  result: number;
  expression: string;
}

export interface ErrorResponse {
  error: string;
  details?: string;
}

export interface ToolListResponse {
  tools: CalculatorToolDefinition[];
}

export interface ToolExecutionSuccessPayload {
  ok: true;
  result: number;
}

export interface ToolExecutionErrorPayload {
  ok: false;
  error: string;
  details?: string;
}

export type ToolExecutionPayload = ToolExecutionSuccessPayload | ToolExecutionErrorPayload;

export type TraceLevel = "INFO" | "ERROR";
export type TraceComponent = "ui" | "client-backend" | "mcp-calculator-server" | "mcp-protocol";

export interface McpConsoleEvent {
  id: number;
  ts: string;
  level: TraceLevel;
  component: TraceComponent;
  event: string;
  summary: string;
  explanation: string;
  data?: Record<string, unknown>;
}

export interface McpConsoleEventsResponse {
  events: McpConsoleEvent[];
}
