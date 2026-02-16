import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  calculatorTools,
  ToolArgsSchema,
  ToolNameSchema,
  type ToolExecutionErrorPayload,
  type ToolExecutionPayload,
  type ToolExecutionSuccessPayload
} from "../shared/types.js";

type LogLevel = "INFO" | "ERROR";

/**
 * Writes structured server logs to stderr.
 *
 * Important MCP rule:
 * - stdout is reserved for protocol JSON-RPC frames
 * - stderr is safe for operational logs
 */
function log(level: LogLevel, event: string, payload: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component: "mcp-calculator-server",
    event,
    ...payload
  });

  console.error(line);
}

/**
 * Helper for typed success payloads returned inside MCP text content.
 */
function successResult(result: number): ToolExecutionSuccessPayload {
  return { ok: true, result };
}

/**
 * Helper for typed error payloads returned inside MCP text content.
 */
function errorResult(error: string, details?: string): ToolExecutionErrorPayload {
  return { ok: false, error, details };
}

/**
 * Wraps success payload into MCP-compliant tool response content.
 */
function toMcpSuccess(payload: ToolExecutionSuccessPayload) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload)
      }
    ]
  };
}

/**
 * Wraps error payload into MCP-compliant tool response content.
 */
function toMcpError(payload: ToolExecutionErrorPayload) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload)
      }
    ]
  };
}

/**
 * Stateless calculator compute function.
 *
 * All calculator memory (current input, pending operator) lives in the UI.
 * MCP server only handles one pure operation at a time.
 */
function compute(tool: z.infer<typeof ToolNameSchema>, a: number, b: number): ToolExecutionPayload {
  switch (tool) {
    case "add":
      return successResult(a + b);

    case "subtract":
      return successResult(a - b);

    case "multiply":
      return successResult(a * b);

    case "divide":
      if (b === 0) {
        return errorResult("Division by zero is not allowed.", "Provide a non-zero divisor.");
      }
      return successResult(a / b);

    default:
      return errorResult("Unknown tool.", `Tool "${String(tool)}" is not implemented.`);
  }
}

/**
 * Bootstraps MCP server and installs request handlers.
 */
async function startServer(): Promise<void> {
  log("INFO", "startup_begin", { message: "Starting MCP Calculator Server" });

  const server = new Server(
    {
      name: "mcp-calculator-server",
      version: "1.0.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  /**
   * Handler: listTools()
   * Returns the 4 calculator operations with JSON Schema argument contracts.
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log("INFO", "tools_list_requested", { toolCount: calculatorTools.length });
    return { tools: calculatorTools };
  });

  /**
   * Handler: callTool(name, arguments)
   * 1) Validate tool name and args with Zod
   * 2) Compute result
   * 3) Return typed success/error payload inside MCP text content
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const rawName = request.params.name;
    const rawArgs = request.params.arguments;

    log("INFO", "tool_call_received", { rawName, rawArgs });

    const toolResult = ToolNameSchema.safeParse(rawName);
    if (!toolResult.success) {
      const payload = errorResult("Unsupported calculator operation.", toolResult.error.message);
      log("ERROR", "tool_call_rejected_unknown_tool", { rawName, details: payload.details });
      return toMcpError(payload);
    }

    const parsedArgs = ToolArgsSchema.safeParse(rawArgs);
    if (!parsedArgs.success) {
      const payload = errorResult("Invalid arguments.", parsedArgs.error.message);
      log("ERROR", "tool_call_rejected_bad_input", {
        tool: toolResult.data,
        details: payload.details
      });
      return toMcpError(payload);
    }

    const { a, b } = parsedArgs.data;
    const execution = compute(toolResult.data, a, b);

    if (!execution.ok) {
      log("ERROR", "tool_call_failed", { tool: toolResult.data, a, b, error: execution.error });
      return toMcpError(execution);
    }

    log("INFO", "tool_call_succeeded", { tool: toolResult.data, a, b, result: execution.result });

    return toMcpSuccess(execution);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("INFO", "startup_complete", {
    message: "MCP calculator server ready",
    tools: calculatorTools.map((tool) => tool.name)
  });
}

startServer().catch((error: unknown) => {
  const details = error instanceof Error ? error.message : String(error);
  log("ERROR", "fatal_startup_error", { details });
  process.exitCode = 1;
});
