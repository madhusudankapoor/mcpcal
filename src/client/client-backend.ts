import path from "node:path";
import type { Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CalculateRequestSchema,
  ToolNameSchema,
  calculatorTools,
  toolInputSchema,
  type CalculateSuccessResponse,
  type CalculatorToolDefinition,
  type ErrorResponse,
  type McpConsoleEvent,
  type McpConsoleEventsResponse,
  type ToolExecutionPayload,
  type ToolName
} from "../shared/types.js";

type LogLevel = "INFO" | "ERROR";

const PORT = Number(process.env.PORT ?? "3000");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TRACE_HISTORY_LIMIT = 200;

const traceClients = new Set<Response>();
const traceHistory: McpConsoleEvent[] = [];
let traceSequence = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function getNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" ? value : undefined;
}

function getBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === "boolean" ? value : undefined;
}

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

function describeTrace(level: LogLevel, event: string, payload: Record<string, unknown>): Omit<McpConsoleEvent, "id" | "ts"> | null {
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
      const a = typeof args.a === "number" ? args.a : "?";
      const b = typeof args.b === "number" ? args.b : "?";
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
      const route = getString(payload, "path");
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
      return null;
    }
    default:
      return null;
  }
}

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

function isToolExecutionPayload(value: unknown): value is ToolExecutionPayload {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }

  if (value.ok) {
    return typeof value.result === "number" && Number.isFinite(value.result);
  }

  return typeof value.error === "string" && (value.details === undefined || typeof value.details === "string");
}

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

const app = express();
app.use(cors());
app.use(express.json());

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

let discoveredTools: CalculatorToolDefinition[] = [];

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
  discoveredTools = normalizeDiscoveredTools(discoveryResponse.tools);
  log("INFO", "mcp_phase_2_discovery_complete", {
    toolCount: discoveredTools.length,
    tools: discoveredTools.map((tool) => tool.name)
  });
}

app.get("/mcp-events", (_req: Request, res: Response<McpConsoleEventsResponse>) => {
  res.json({ events: traceHistory });
});

app.get("/mcp-events/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write("retry: 1200\n\n");

  for (const trace of traceHistory) {
    res.write(`event: trace\ndata: ${JSON.stringify(trace)}\n\n`);
  }

  traceClients.add(res);
  const keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 20_000);

  req.on("close", () => {
    clearInterval(keepAlive);
    traceClients.delete(res);
  });
});

const publicDir = path.resolve(__dirname, "../../public");
app.use(express.static(publicDir));

app.get("/tools", (_req: Request, res: Response) => {
  const response = { tools: discoveredTools };
  res.json(response);
});

app.post(
  "/calculate",
  async (
    req: Request,
    res: Response<CalculateSuccessResponse | ErrorResponse>,
    next: NextFunction
  ): Promise<void> => {
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
      const rawToolResponse = await mcpClient.callTool({
        name: requestBody.tool,
        arguments: requestBody.args
      });

      const isErrorResponse = isRecord(rawToolResponse) ? rawToolResponse.isError === true : false;
      log("INFO", "mcp_phase_3_tool_execution_response", {
        tool: requestBody.tool,
        isError: isErrorResponse
      });

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

app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((error: unknown, _req: Request, res: Response<ErrorResponse>, _next: NextFunction) => {
  const details = error instanceof Error ? error.stack ?? error.message : String(error);
  log("ERROR", "unhandled_backend_error", { details });
  res.status(500).json({
    error: "Internal server error.",
    details: error instanceof Error ? error.message : String(error)
  });
});

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
