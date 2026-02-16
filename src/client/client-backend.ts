import "dotenv/config";
import path from "node:path";
import type { Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import OpenAI from "openai";
import type { ChatCompletionTool, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  CalculateRequestSchema,
  ChatRequestSchema,
  ToolNameSchema,
  ToolArgsSchema,
  calculatorTools,
  toolInputSchema,
  type CalculateSuccessResponse,
  type CalculatorToolDefinition,
  type ChatResponse,
  type ChatToolCall,
  type ErrorResponse,
  type McpConsoleEvent,
  type McpConsoleEventsResponse,
  type ToolExecutionPayload,
  type ToolName
} from "../shared/types.js";

type LogLevel = "INFO" | "ERROR";

/**
 * ---------------------------------------------------------------------------
 * Runtime constants and process-level state
 * ---------------------------------------------------------------------------
 */
const PORT                = Number(process.env.PORT ?? "3000");
const __filename          = fileURLToPath(import.meta.url);
const __dirname           = path.dirname(__filename);
const TRACE_HISTORY_LIMIT = 200;

/**
 * OpenAI client — reads OPENAI_API_KEY from env automatically.
 */
const openai = new OpenAI();

/**
 * SSE clients currently subscribed to /mcp-events/stream.
 */
const traceClients = new Set<Response>();

/**
 * In-memory rolling trace history shown in the MCP learning console.
 */
const traceHistory: McpConsoleEvent[] = [];
let traceSequence                      = 1;

/**
 * ---------------------------------------------------------------------------
 * Generic runtime helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Runtime object check used before property access on unknown payloads.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Safe string extraction from generic object payloads.
 */
function getString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Safe number extraction from generic object payloads.
 */
function getNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Safe boolean extraction from generic object payloads.
 */
function getBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * ---------------------------------------------------------------------------
 * MCP learning-console trace stream helpers
 * ---------------------------------------------------------------------------
 */

/**
 * Sends one SSE trace frame to all connected browsers.
 */
function writeTraceToClients(trace: McpConsoleEvent): void {
  const frame = `event: trace\ndata: ${JSON.stringify(trace)}\n\n`;

  for (const client of traceClients) {
    try {
      client.write(frame);
    } catch {
      traceClients.delete(client);
    }
  }
}

/**
 * Adds a trace item to memory history and broadcasts it to live subscribers.
 */
function publishTrace(trace: Omit<McpConsoleEvent, "id" | "ts">): void {
  const nextTrace: McpConsoleEvent = {
    id: traceSequence,
    ts: new Date().toISOString(),
    ...trace
  };

  traceSequence += 1;
  traceHistory.push(nextTrace);

  if (traceHistory.length > TRACE_HISTORY_LIMIT) {
    traceHistory.shift();
  }

  writeTraceToClients(nextTrace);
}

/**
 * Converts backend machine events into user-facing learning explanations.
 */
function describeTrace(
  level: LogLevel,
  event: string,
  payload: Record<string, unknown>
): Omit<McpConsoleEvent, "id" | "ts"> | null {
  switch (event) {
    case "mcp_phase_1_initialization_started":
      return {
        level,
        component: "client-backend",
        event,
        summary: "Phase 1: MCP handshake is starting.",
        explanation: "The backend spawns the MCP server process and opens stdio transport for RPC.",
        data: payload
      };

    case "mcp_phase_1_handshake_complete":
      return {
        level,
        component: "client-backend",
        event,
        summary: "Phase 1 complete: handshake and capabilities negotiation succeeded.",
        explanation: "Client and server agreed on protocol capabilities, so tool calls can now be sent.",
        data: payload
      };

    case "mcp_phase_2_discovery_started":
      return {
        level,
        component: "client-backend",
        event,
        summary: "Phase 2: discovering available tools.",
        explanation: "Backend calls listTools() so the UI can enable only supported operations.",
        data: payload
      };

    case "mcp_phase_2_discovery_complete":
      return {
        level,
        component: "client-backend",
        event,
        summary: `Phase 2 complete: discovered ${String(getNumber(payload, "toolCount") ?? 0)} tool(s).`,
        explanation: "Tool definitions include JSON Schema, so clients know exactly what arguments to send.",
        data: payload
      };

    case "mcp_phase_3_tool_execution_started": {
      const tool = getString(payload, "tool") ?? "unknown";
      const args = isRecord(payload.args) ? payload.args : {};
      const a    = typeof args.a === "number" ? args.a : "?";
      const b    = typeof args.b === "number" ? args.b : "?";

      return {
        level,
        component: "client-backend",
        event,
        summary: `Phase 3: executing ${tool}(${String(a)}, ${String(b)}).`,
        explanation: "Request passed HTTP validation, and backend is now sending callTool() to the MCP server.",
        data: payload
      };
    }

    case "mcp_phase_3_tool_execution_response": {
      const isError = getBoolean(payload, "isError") === true;
      return {
        level,
        component: "client-backend",
        event,
        summary: isError ? "Phase 3 response: MCP reported an error." : "Phase 3 response: MCP returned a result.",
        explanation: "Backend parses MCP text content into typed JSON before replying to the browser.",
        data: payload
      };
    }

    case "request_validation_failed":
      return {
        level,
        component: "client-backend",
        event,
        summary: "HTTP validation failed before MCP call.",
        explanation: "Zod blocked invalid request data at runtime, preventing bad RPC messages.",
        data: payload
      };

    case "http_server_ready":
      return {
        level,
        component: "client-backend",
        event,
        summary: `Express server is ready on port ${String(getNumber(payload, "port") ?? PORT)}.`,
        explanation: "Web UI can now load and call /tools, /calculate, and /mcp-events/stream.",
        data: payload
      };

    case "unhandled_backend_error":
      return {
        level,
        component: "client-backend",
        event,
        summary: "Backend encountered an unhandled error.",
        explanation: "Error middleware caught the failure and returned a typed error response.",
        data: payload
      };

    case "startup_failed":
      return {
        level,
        component: "client-backend",
        event,
        summary: "Backend startup failed.",
        explanation: "Initialization could not complete, so the server process exits safely.",
        data: payload
      };

    case "http_request_started": {
      const method = getString(payload, "method");
      const route  = getString(payload, "path");

      if (method === "GET" && route === "/tools") {
        return {
          level,
          component: "mcp-protocol",
          event,
          summary: "UI requested discovered MCP tools.",
          explanation: "This is how the browser learns operations dynamically instead of hardcoding backend capabilities.",
          data: payload
        };
      }

      if (method === "POST" && route === "/calculate") {
        return {
          level,
          component: "mcp-protocol",
          event,
          summary: "UI sent a calculation request.",
          explanation: "The backend will validate input and proxy it to MCP as callTool().",
          data: payload
        };
      }

      if (method === "POST" && route === "/chat") {
        return {
          level,
          component: "openai",
          event,
          summary: "UI sent a chat message.",
          explanation: "The backend will forward this to OpenAI with MCP tool definitions for function calling.",
          data: payload
        };
      }

      return null;
    }

    case "llm_request":
      return {
        level,
        component: "openai",
        event,
        summary: "Sending request to OpenAI.",
        explanation: "Backend sends user message + MCP tool definitions to the LLM for function-calling.",
        data: payload
      };

    case "llm_tool_selection": {
      const count = getNumber(payload, "count") ?? 0;
      return {
        level,
        component: "openai",
        event,
        summary: `OpenAI selected ${String(count)} tool call(s).`,
        explanation: "The LLM chose MCP tools to call based on the user's natural language request.",
        data: payload
      };
    }

    case "llm_response":
      return {
        level,
        component: "openai",
        event,
        summary: "OpenAI returned final response.",
        explanation: "After tool results were sent back, the LLM generated a natural language answer.",
        data: payload
      };

    default:
      return null;
  }
}

/**
 * Structured backend logger + learning-trace publisher.
 */
function log(level: LogLevel, event: string, payload: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: "client-backend",
      event,
      ...payload
    })
  );

  const trace = describeTrace(level, event, payload);
  if (trace) {
    publishTrace(trace);
  }
}

/**
 * ---------------------------------------------------------------------------
 * MCP/HTTP payload shape guards
 * ---------------------------------------------------------------------------
 */

/**
 * Validates parsed MCP text payload shape ({ok:true}|{ok:false}).
 */
function isToolExecutionPayload(value: unknown): value is ToolExecutionPayload {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }

  if (value.ok) {
    return typeof value.result === "number" && Number.isFinite(value.result);
  }

  return typeof value.error === "string" && (value.details === undefined || typeof value.details === "string");
}

/**
 * Defensive validator for tool input schemas discovered from MCP listTools().
 */
function isCalculatorInputSchema(value: unknown): value is CalculatorToolDefinition["inputSchema"] {
  if (!isRecord(value)) {
    return false;
  }

  if (value.type !== "object" || value.additionalProperties !== false || !Array.isArray(value.required)) {
    return false;
  }

  if (!value.required.includes("a") || !value.required.includes("b")) {
    return false;
  }

  if (!isRecord(value.properties)) {
    return false;
  }

  const a = value.properties.a;
  const b = value.properties.b;
  return isRecord(a) && isRecord(b) && a.type === "number" && b.type === "number";
}

/**
 * Pulls first text content block from MCP callTool() response.
 */
function extractPayloadText(rawResponse: unknown): string | null {
  if (!isRecord(rawResponse) || !Array.isArray(rawResponse.content)) {
    return null;
  }

  const textItem = rawResponse.content.find((item: unknown) => {
    return isRecord(item) && item.type === "text" && typeof item.text === "string";
  });

  if (!textItem || !isRecord(textItem)) {
    return null;
  }

  return textItem.text as string;
}

/**
 * Parses and validates tool payload embedded by the MCP server.
 */
function parseToolPayload(rawResponse: unknown): ToolExecutionPayload | null {
  const text = extractPayloadText(rawResponse);
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return isToolExecutionPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Maps tool names to symbols for user expression display.
 */
function operatorForTool(tool: ToolName): string {
  switch (tool) {
    case "add":
      return "+";
    case "subtract":
      return "-";
    case "multiply":
      return "×";
    case "divide":
      return "/";
    default:
      return "?";
  }
}

/**
 * Normalizes listTools() response to our strict shared type.
 */
function normalizeDiscoveredTools(rawTools: unknown): CalculatorToolDefinition[] {
  if (!Array.isArray(rawTools)) {
    return [];
  }

  return rawTools
    .filter((tool): tool is Record<string, unknown> => isRecord(tool))
    .map((tool): CalculatorToolDefinition | null => {
      const nameResult = ToolNameSchema.safeParse(tool.name);
      if (!nameResult.success) {
        return null;
      }

      const description =
        typeof tool.description === "string"
          ? tool.description
          : calculatorTools.find((item) => item.name === nameResult.data)?.description ?? "Calculator tool";

      const inputSchema = isCalculatorInputSchema(tool.inputSchema) ? tool.inputSchema : toolInputSchema;

      return {
        name: nameResult.data,
        description,
        inputSchema
      };
    })
    .filter((tool): tool is CalculatorToolDefinition => tool !== null);
}

let discoveredTools: CalculatorToolDefinition[] = [];

/**
 * Maps discovered MCP tools into OpenAI function-calling format.
 */
function buildOpenAiFunctions(): ChatCompletionTool[] {
  return discoveredTools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: tool.inputSchema.properties,
        required: tool.inputSchema.required,
        additionalProperties: false
      }
    }
  }));
}

/**
 * ---------------------------------------------------------------------------
 * Express app setup + MCP client setup
 * ---------------------------------------------------------------------------
 */
const app = express();
app.use(cors());
app.use(express.json());

/**
 * Request timing logger. We keep this middleware high in stack so all routes are visible.
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  log("INFO", "http_request_started", { method: req.method, path: req.path });

  res.on("finish", () => {
    log("INFO", "http_request_finished", {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - start
    });
  });

  next();
});

const mcpServerEntry = process.env.MCP_SERVER_ENTRY
  ? path.resolve(process.cwd(), process.env.MCP_SERVER_ENTRY)
  : path.resolve(__dirname, "../server/calculator-server.js");

const mcpTransport = new StdioClientTransport({
  command: process.execPath,
  args: [mcpServerEntry]
});

const mcpClient = new Client(
  {
    name: "mcp-calculator-client-backend",
    version: "1.0.0"
  },
  {
    capabilities: {}
  }
);

/**
 * Performs Phase 1 + Phase 2 MCP startup sequence.
 */
async function initializeMcp(): Promise<void> {
  publishTrace({
    level: "INFO",
    component: "mcp-calculator-server",
    event: "startup_begin",
    summary: "MCP server process is starting.",
    explanation: "A separate process boots and listens on stdio for MCP JSON-RPC messages.",
    data: { mcpServerEntry }
  });

  log("INFO", "mcp_phase_1_initialization_started", {
    message: "Spawning MCP server and starting handshake",
    mcpServerEntry
  });

  await mcpClient.connect(mcpTransport);

  publishTrace({
    level: "INFO",
    component: "mcp-calculator-server",
    event: "startup_complete",
    summary: "MCP server is ready.",
    explanation: "Server startup completed, so the client can negotiate capabilities and call tools."
  });

  log("INFO", "mcp_phase_1_handshake_complete", {
    message: "Handshake complete and capabilities negotiated"
  });

  log("INFO", "mcp_phase_2_discovery_started", { message: "Requesting listTools" });

  publishTrace({
    level: "INFO",
    component: "mcp-calculator-server",
    event: "tools_list_requested",
    summary: "MCP server received listTools().",
    explanation: "Server is returning tool names, descriptions, and JSON Schemas.",
    data: { toolCount: calculatorTools.length }
  });

  const discoveryResponse = await mcpClient.listTools();
  discoveredTools         = normalizeDiscoveredTools(discoveryResponse.tools);

  log("INFO", "mcp_phase_2_discovery_complete", {
    toolCount: discoveredTools.length,
    tools: discoveredTools.map((tool) => tool.name)
  });
}

/**
 * ---------------------------------------------------------------------------
 * Learning-console endpoints
 * ---------------------------------------------------------------------------
 */

/**
 * Returns current trace history snapshot.
 */
app.get("/mcp-events", (_req: Request, res: Response<McpConsoleEventsResponse>) => {
  res.json({ events: traceHistory });
});

/**
 * Streams trace events live via Server-Sent Events (SSE).
 */
app.get("/mcp-events/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Ask browser EventSource to retry quickly if connection drops.
  res.write("retry: 1200\n\n");

  // Send history first so new subscribers get startup context immediately.
  for (const trace of traceHistory) {
    res.write(`event: trace\ndata: ${JSON.stringify(trace)}\n\n`);
  }

  traceClients.add(res);

  // Keep stream alive through proxies/load balancers.
  const keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 20_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    traceClients.delete(res);
  });
});

/**
 * Static assets must be mounted after JSON/SSE routes setup.
 */
const publicDir = path.resolve(__dirname, "../../public");
app.use(express.static(publicDir));

/**
 * ---------------------------------------------------------------------------
 * Core API routes
 * ---------------------------------------------------------------------------
 */

/**
 * Exposes currently discovered tools to the browser.
 */
app.get("/tools", (_req: Request, res: Response) => {
  const response = { tools: discoveredTools };
  res.json(response);
});

/**
 * Executes calculator operation via MCP callTool().
 */
app.post(
  "/calculate",
  async (
    req: Request,
    res: Response<CalculateSuccessResponse | ErrorResponse>,
    next: NextFunction
  ): Promise<void> => {
    /**
     * Step 1: HTTP runtime validation.
     */
    const validation = CalculateRequestSchema.safeParse(req.body);
    if (!validation.success) {
      log("ERROR", "request_validation_failed", {
        route: "/calculate",
        issues: validation.error.flatten()
      });

      res.status(400).json({
        error: "Invalid request payload.",
        details: validation.error.message
      });
      return;
    }

    const requestBody = validation.data;

    log("INFO", "mcp_phase_3_tool_execution_started", {
      tool: requestBody.tool,
      args: requestBody.args
    });

    publishTrace({
      level: "INFO",
      component: "mcp-calculator-server",
      event: "tool_call_received",
      summary: `MCP server received ${requestBody.tool}(${String(requestBody.args.a)}, ${String(requestBody.args.b)}).`,
      explanation: "Server validates tool arguments with Zod before executing the operation.",
      data: {
        tool: requestBody.tool,
        args: requestBody.args
      }
    });

    try {
      /**
       * Step 2: MCP RPC call.
       */
      const rawToolResponse = await mcpClient.callTool({
        name: requestBody.tool,
        arguments: requestBody.args
      });

      const isErrorResponse = isRecord(rawToolResponse) ? rawToolResponse.isError === true : false;
      log("INFO", "mcp_phase_3_tool_execution_response", {
        tool: requestBody.tool,
        isError: isErrorResponse
      });

      /**
       * Step 3: Parse typed payload encoded by MCP server.
       */
      const parsedPayload = parseToolPayload(rawToolResponse);
      if (!parsedPayload) {
        publishTrace({
          level: "ERROR",
          component: "mcp-protocol",
          event: "tool_payload_parse_failed",
          summary: "Backend could not parse MCP tool response.",
          explanation: "Expected a text content block containing JSON with either {ok:true} or {ok:false}.",
          data: { tool: requestBody.tool }
        });

        res.status(502).json({
          error: "Invalid response from MCP server.",
          details: "Expected JSON text payload with tool result."
        });
        return;
      }

      /**
       * Step 4a: Propagate typed MCP error to UI.
       */
      if (!parsedPayload.ok) {
        publishTrace({
          level: "ERROR",
          component: "mcp-calculator-server",
          event: "tool_call_failed",
          summary: `Tool execution failed: ${parsedPayload.error}`,
          explanation: "MCP server returned a typed error payload; backend relays it to the UI.",
          data: {
            tool: requestBody.tool,
            error: parsedPayload.error,
            details: parsedPayload.details
          }
        });

        res.status(400).json({
          error: parsedPayload.error,
          details: parsedPayload.details
        });
        return;
      }

      /**
       * Step 4b: Convert typed MCP success into UI-friendly response.
       */
      publishTrace({
        level: "INFO",
        component: "mcp-calculator-server",
        event: "tool_call_succeeded",
        summary: `Tool executed successfully with result ${String(parsedPayload.result)}.`,
        explanation: "Server returned a typed success payload and backend converted it to UI response format.",
        data: {
          tool: requestBody.tool,
          result: parsedPayload.result
        }
      });

      const expression = `${requestBody.args.a} ${operatorForTool(requestBody.tool)} ${requestBody.args.b}`;

      res.json({
        result: parsedPayload.result,
        expression
      });
    } catch (error: unknown) {
      next(error);
    }
  }
);

/**
 * Chat endpoint: forwards natural language to OpenAI with MCP tool definitions.
 */
app.post(
  "/chat",
  async (
    req: Request,
    res: Response<ChatResponse | ErrorResponse>,
    next: NextFunction
  ): Promise<void> => {
    const validation = ChatRequestSchema.safeParse(req.body);
    if (!validation.success) {
      log("ERROR", "request_validation_failed", {
        route: "/chat",
        issues: validation.error.flatten()
      });
      res.status(400).json({
        error: "Invalid chat request.",
        details: validation.error.message
      });
      return;
    }

    const { message } = validation.data;
    const tools = buildOpenAiFunctions();
    const chatToolCalls: ChatToolCall[] = [];

    try {
      log("INFO", "llm_request", { message, toolCount: tools.length });

      const messages: ChatCompletionMessageParam[] = [
        {
          role: "system",
          content:
            "You are a calculator assistant. Use the provided tools to perform arithmetic. " +
            "If the user asks something that is not a math operation, politely explain that you can only help with calculations."
        },
        { role: "user", content: message }
      ];

      /**
       * First OpenAI call: send user message + tool definitions.
       */
      const firstResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        tools: tools.length > 0 ? tools : undefined
      });

      const choice = firstResponse.choices[0];
      if (!choice) {
        res.status(502).json({ error: "OpenAI returned no choices." });
        return;
      }

      /**
       * If no tool calls, return the LLM response directly.
       */
      if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
        log("INFO", "llm_response", { hasToolCalls: false });
        res.json({
          response: choice.message.content ?? "I could not generate a response.",
          toolCalls: []
        });
        return;
      }

      const functionCalls = choice.message.tool_calls.filter(
        (tc): tc is Extract<typeof tc, { type: "function" }> => tc.type === "function"
      );

      log("INFO", "llm_tool_selection", {
        count: functionCalls.length,
        tools: functionCalls.map((tc) => tc.function.name)
      });

      /**
       * Execute each tool call via MCP.
       */
      messages.push(choice.message);

      for (const toolCall of functionCalls) {
        const fnName = toolCall.function.name;
        let fnArgs: Record<string, unknown>;

        try {
          fnArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
        } catch {
          const errorMsg = "Failed to parse tool arguments.";
          chatToolCalls.push({ tool: fnName, args: {}, error: errorMsg });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ ok: false, error: errorMsg })
          });
          continue;
        }

        const nameResult = ToolNameSchema.safeParse(fnName);
        const argsResult = ToolArgsSchema.safeParse(fnArgs);

        if (!nameResult.success || !argsResult.success) {
          const errorMsg = "Invalid tool name or arguments.";
          chatToolCalls.push({ tool: fnName, args: fnArgs, error: errorMsg });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ ok: false, error: errorMsg })
          });
          continue;
        }

        log("INFO", "mcp_phase_3_tool_execution_started", {
          tool: nameResult.data,
          args: argsResult.data
        });

        const rawToolResponse = await mcpClient.callTool({
          name: nameResult.data,
          arguments: argsResult.data
        });

        const parsedPayload = parseToolPayload(rawToolResponse);

        if (parsedPayload) {
          chatToolCalls.push({ tool: fnName, args: fnArgs, result: parsedPayload });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(parsedPayload)
          });
        } else {
          const errorMsg = "Failed to parse MCP tool response.";
          chatToolCalls.push({ tool: fnName, args: fnArgs, error: errorMsg });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ ok: false, error: errorMsg })
          });
        }

        log("INFO", "mcp_phase_3_tool_execution_response", {
          tool: fnName,
          isError: !parsedPayload || !parsedPayload.ok
        });
      }

      /**
       * Second OpenAI call: send tool results back for a natural language answer.
       */
      const secondResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages
      });

      const finalChoice = secondResponse.choices[0];
      const responseText = finalChoice?.message.content ?? "I could not generate a response.";

      log("INFO", "llm_response", { hasToolCalls: true, toolCallCount: chatToolCalls.length });

      res.json({
        response: responseText,
        toolCalls: chatToolCalls
      });
    } catch (error: unknown) {
      next(error);
    }
  }
);

app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

/**
 * Centralized error-to-JSON mapper for unhandled backend failures.
 */
app.use((error: unknown, _req: Request, res: Response<ErrorResponse>, _next: NextFunction) => {
  const details = error instanceof Error ? error.stack ?? error.message : String(error);
  log("ERROR", "unhandled_backend_error", { details });

  res.status(500).json({
    error: "Internal server error.",
    details: error instanceof Error ? error.message : String(error)
  });
});

/**
 * ---------------------------------------------------------------------------
 * Process lifecycle (startup + graceful shutdown)
 * ---------------------------------------------------------------------------
 */
let httpServer: HttpServer | null = null;

async function start(): Promise<void> {
  try {
    await initializeMcp();

    httpServer = app.listen(PORT, () => {
      log("INFO", "http_server_ready", { port: PORT });
    });
  } catch (error: unknown) {
    const details = error instanceof Error ? error.message : String(error);
    log("ERROR", "startup_failed", { details });
    process.exit(1);
  }
}

void start();

let shuttingDown = false;

/**
 * Closes resources in a safe order:
 * 1) MCP client session
 * 2) stdio transport
 * 3) HTTP server
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  log("INFO", "shutdown_started", { signal });

  try {
    await mcpClient.close();
    log("INFO", "mcp_client_closed");
  } catch (error: unknown) {
    log("ERROR", "mcp_client_close_failed", {
      details: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    await mcpTransport.close();
    log("INFO", "mcp_transport_closed");
  } catch (error: unknown) {
    log("ERROR", "mcp_transport_close_failed", {
      details: error instanceof Error ? error.message : String(error)
    });
  }

  // End all SSE connections so httpServer.close() can drain.
  for (const client of traceClients) {
    client.end();
  }
  traceClients.clear();

  if (!httpServer) {
    process.exit(0);
    return;
  }

  httpServer.close(() => {
    log("INFO", "http_server_closed");
    process.exit(0);
  });
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
