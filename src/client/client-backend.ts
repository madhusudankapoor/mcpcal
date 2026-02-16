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
  type ToolExecutionPayload,
  type ToolName
} from "../shared/types.js";

type LogLevel = "INFO" | "ERROR";

const PORT = Number(process.env.PORT ?? "3000");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

const publicDir = path.resolve(__dirname, "../../public");
app.use(express.static(publicDir));

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
  log("INFO", "mcp_phase_1_initialization_started", {
    message: "Spawning MCP server and starting handshake",
    mcpServerEntry
  });

  await mcpClient.connect(mcpTransport);
  log("INFO", "mcp_phase_1_handshake_complete", {
    message: "Handshake complete and capabilities negotiated"
  });

  log("INFO", "mcp_phase_2_discovery_started", { message: "Requesting listTools" });
  const discoveryResponse = await mcpClient.listTools();
  discoveredTools = normalizeDiscoveredTools(discoveryResponse.tools);
  log("INFO", "mcp_phase_2_discovery_complete", {
    toolCount: discoveredTools.length,
    tools: discoveredTools.map((tool) => tool.name)
  });
}

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

    try {
      const rawToolResponse = await mcpClient.callTool({
        name: requestBody.tool,
        arguments: requestBody.args
      });

      log("INFO", "mcp_phase_3_tool_execution_response", {
        tool: requestBody.tool,
        isError: isRecord(rawToolResponse) ? rawToolResponse.isError === true : false
      });

      const parsedPayload = parseToolPayload(rawToolResponse);
      if (!parsedPayload) {
        res.status(502).json({
          error: "Invalid response from MCP server.",
          details: "Expected JSON text payload with tool result."
        });
        return;
      }

      if (!parsedPayload.ok) {
        res.status(400).json({
          error: parsedPayload.error,
          details: parsedPayload.details
        });
        return;
      }

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
