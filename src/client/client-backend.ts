import "dotenv/config";
import path from "node:path";
import type { Server as HttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
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
  type CalculateSuccessResponse,
  type CalculatorToolDefinition,
  type ChatResponse,
  type ChatToolCall,
  type ErrorResponse,
  type McpConsoleEventsResponse
} from "../shared/types.js";

import { isRecord } from "./utils.js";
import { parseToolPayload, operatorForTool, normalizeDiscoveredTools } from "./mcp-payload.js";
import { log, publishTrace, traceClients, traceHistory } from "./trace.js";
import { summarizeMessagesForHumans, summarizeLlmResponseForHumans } from "./formatters.js";

/* ---------------------------------------------------------------------------
 * Constants and state
 * --------------------------------------------------------------------------- */

const PORT       = Number(process.env.PORT ?? "3000");
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const openai     = new OpenAI();

/* MCP tools discovered at startup via listTools(). */
let discoveredTools: CalculatorToolDefinition[] = [];

/* ---------------------------------------------------------------------------
 * AI HELPERS — the educational core
 * --------------------------------------------------------------------------- */

/* Build the system prompt + user message for the LLM. */
function buildConversation(userMessage: string): ChatCompletionMessageParam[] {
  return [
    {
      role: "system",
      content:
        "You are a calculator assistant. Use the provided tools to perform arithmetic. " +
        "Always use tools for every arithmetic step — never compute results mentally. " +
        "Always respond in plain text without any LaTeX, markdown, or special formatting. " +
        "If the user asks something that is not a math operation, politely explain that you can only help with calculations."
    },
    { role: "user", content: userMessage }
  ];
}

/* Translate MCP tool definitions into OpenAI's function-calling format. */
function convertMcpToolsToOpenAiFormat(): ChatCompletionTool[] {
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

/* Execute a single tool call: parse args → validate → MCP callTool → parse result. */
async function executeSingleToolCall(
  toolCall: { id: string; function: { name: string; arguments: string } },
  mcp: Client
): Promise<{
  chatToolCall: ChatToolCall;
  toolMessage: ChatCompletionMessageParam;
}> {
  const fnName = toolCall.function.name;

  // Parse the LLM-generated argument string.
  let fnArgs: Record<string, unknown>;
  try {
    fnArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
  } catch {
    const errorMsg = "Failed to parse tool arguments.";
    return {
      chatToolCall: { tool: fnName, args: {}, error: errorMsg },
      toolMessage: {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({ ok: false, error: errorMsg })
      }
    };
  }

  // Validate tool name and args against Zod schemas.
  const nameResult = ToolNameSchema.safeParse(fnName);
  const argsResult = ToolArgsSchema.safeParse(fnArgs);

  if (!nameResult.success || !argsResult.success) {
    const errorMsg = "Invalid tool name or arguments.";
    return {
      chatToolCall: { tool: fnName, args: fnArgs, error: errorMsg },
      toolMessage: {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({ ok: false, error: errorMsg })
      }
    };
  }

  // Execute via MCP callTool().
  log("INFO", "mcp_phase_3_tool_execution_started", {
    tool: nameResult.data,
    args: argsResult.data
  });

  const rawToolResponse = await mcp.callTool({
    name: nameResult.data,
    arguments: argsResult.data
  });

  // Parse the typed payload from the MCP response.
  const parsedPayload = parseToolPayload(rawToolResponse);

  log("INFO", "mcp_phase_3_tool_execution_response", {
    tool: fnName,
    isError: !parsedPayload || !parsedPayload.ok
  });

  if (parsedPayload) {
    return {
      chatToolCall: { tool: fnName, args: fnArgs, result: parsedPayload },
      toolMessage: {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(parsedPayload)
      }
    };
  }

  const errorMsg = "Failed to parse MCP tool response.";
  return {
    chatToolCall: { tool: fnName, args: fnArgs, error: errorMsg },
    toolMessage: {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify({ ok: false, error: errorMsg })
    }
  };
}

/* Execute a batch of tool calls from one LLM response. */
async function executeToolCallsFromLlm(
  functionCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>,
  mcp: Client
): Promise<{
  chatToolCalls: ChatToolCall[];
  toolMessages: ChatCompletionMessageParam[];
}> {
  const chatToolCalls: ChatToolCall[] = [];
  const toolMessages: ChatCompletionMessageParam[] = [];

  for (const toolCall of functionCalls) {
    const result = await executeSingleToolCall(toolCall, mcp);
    chatToolCalls.push(result.chatToolCall);
    toolMessages.push(result.toolMessage);
  }

  return { chatToolCalls, toolMessages };
}

/* The agentic loop: observe → think → act until done or maxRounds. */
async function runAgenticLoop(
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  mcp: Client,
  maxRounds: number
): Promise<ChatResponse> {
  const allToolCalls: ChatToolCall[] = [];
  let round = 0;

  while (round < maxRounds) {
    round += 1;

    log("INFO", "llm_agentic_round", { round });

    // Log what we're sending to the LLM this round.
    log("INFO", "llm_sending_messages", {
      round,
      messageCount: messages.length,
      conversationSnapshot: summarizeMessagesForHumans(messages)
    });

    // Send conversation to LLM — it will either call tools or return a final answer.
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 1024,
      messages,
      tools: tools.length > 0 ? tools : undefined
    });

    const choice = response.choices[0];
    if (!choice) {
      return {
        response: "OpenAI returned no choices.",
        toolCalls: allToolCalls
      };
    }

    // Log what the LLM returned.
    log("INFO", "llm_received_response", {
      round,
      hasText: !!choice.message.content,
      hasToolCalls: !!choice.message.tool_calls && choice.message.tool_calls.length > 0,
      toolCallCount: choice.message.tool_calls?.length ?? 0,
      finishReason: choice.finish_reason,
      responseSnapshot: summarizeLlmResponseForHumans({
        message: {
          content: choice.message.content,
          tool_calls: choice.message.tool_calls as unknown as Array<Record<string, unknown>> | undefined
        }
      })
    });

    // Chain of Thought: LLM included reasoning text alongside tool calls.
    if (choice.message.content && choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      log("INFO", "llm_chain_of_thought", {
        round,
        thought: choice.message.content
      });
    }

    // LLM returned text only — it's done reasoning, return the answer.
    if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
      const responseText = choice.message.content ?? "I could not generate a response.";

      log("INFO", "llm_response", {
        hasToolCalls: allToolCalls.length > 0,
        toolCallCount: allToolCalls.length,
        rounds: round,
        termination: "natural",
        finalAnswer: responseText
      });

      return {
        response: responseText,
        toolCalls: allToolCalls
      };
    }

    // LLM wants to call tools — execute them and feed results back for the next round.
    const functionCalls = choice.message.tool_calls.filter(
      (tc): tc is Extract<typeof tc, { type: "function" }> => tc.type === "function"
    );

    log("INFO", "llm_tool_selection", {
      round,
      count: functionCalls.length,
      tools: functionCalls.map((tc) => tc.function.name),
      toolDetails: functionCalls.map((tc) => {
        let parsedArgs: Record<string, unknown> = {};
        try { parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>; } catch { /* ignore */ }
        return { name: tc.function.name, args: parsedArgs };
      })
    });

    messages.push(choice.message);

    const { chatToolCalls, toolMessages } = await executeToolCallsFromLlm(functionCalls, mcp);
    allToolCalls.push(...chatToolCalls);

    // Log tool results being fed back before the next round.
    const toolResultsSummary = chatToolCalls.map((tc) => {
      const argsStr = Object.values(tc.args).join(", ");
      const parsed = isRecord(tc.result) ? tc.result : null;
      if (parsed && parsed.ok === true && typeof parsed.result === "number") {
        return `${tc.tool}(${argsStr}) = ${String(parsed.result)}`;
      }
      return `${tc.tool}(${argsStr}) → ERROR: ${tc.error ?? "unknown"}`;
    });

    log("INFO", "llm_tool_results_feeding_back", {
      round,
      resultCount: toolMessages.length,
      results: toolResultsSummary
    });

    messages.push(...toolMessages);
  }

  // Safety termination: hit maxRounds without a final answer.
  log("INFO", "llm_response", {
    hasToolCalls: true,
    toolCallCount: allToolCalls.length,
    rounds: round,
    termination: "safety_limit"
  });

  return {
    response: "Reached maximum tool-calling rounds. Here are the results so far.",
    toolCalls: allToolCalls
  };
}

/* ---------------------------------------------------------------------------
 * Express app + MCP client setup
 * --------------------------------------------------------------------------- */

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------------------------------------------------------------------
 * Rate limiting – protects against abuse and runaway LLM costs.
 * --------------------------------------------------------------------------- */

/** General limiter: 100 requests per 15 minutes per IP. */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." }
});

/** Strict limiter for LLM-powered endpoints: 10 requests per minute per IP. */
const llmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many AI requests. Please slow down and try again in a minute." }
});

app.use(generalLimiter);
app.use("/chat", llmLimiter);
app.use("/calculate", llmLimiter);

/* Request timing logger (skips /healthz to reduce noise). */
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/healthz") {
    next();
    return;
  }

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
  { name: "mcp-calculator-client-backend", version: "1.0.0" },
  { capabilities: {} }
);

/* Phase 1 + Phase 2 MCP startup sequence. */
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

/* ---------------------------------------------------------------------------
 * Routes
 * --------------------------------------------------------------------------- */

/* Trace history snapshot. */
app.get("/mcp-events", (_req: Request, res: Response<McpConsoleEventsResponse>) => {
  res.json({ events: traceHistory });
});

/* Live SSE trace stream. */
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

/* Static assets (after JSON/SSE routes). */
const publicDir = path.resolve(__dirname, "../../public");
app.use(express.static(publicDir));

/* Health probe. */
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

/* Discovered tools for the browser. */
app.get("/tools", (_req: Request, res: Response) => {
  res.json({ tools: discoveredTools });
});

/* Execute calculator operation via MCP callTool(). */
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
      data: { tool: requestBody.tool, args: requestBody.args }
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
          data: { tool: requestBody.tool, error: parsedPayload.error, details: parsedPayload.details }
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
        data: { tool: requestBody.tool, result: parsedPayload.result }
      });

      const expression = `${requestBody.args.a} ${operatorForTool(requestBody.tool)} ${requestBody.args.b}`;
      res.json({ result: parsedPayload.result, expression });
    } catch (error: unknown) {
      next(error);
    }
  }
);

/* Chat endpoint: validate → build conversation → convert tools → agentic loop → respond. */
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

    try {
      const messages = buildConversation(message);
      const tools = convertMcpToolsToOpenAiFormat();

      log("INFO", "llm_request", { message, toolCount: tools.length });

      const chatResponse = await runAgenticLoop(messages, tools, mcpClient, 10);
      res.json(chatResponse);
    } catch (error: unknown) {
      next(error);
    }
  }
);

app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

/* Centralized error-to-JSON mapper. */
app.use((error: unknown, _req: Request, res: Response<ErrorResponse>, _next: NextFunction) => {
  const details = error instanceof Error ? error.stack ?? error.message : String(error);
  log("ERROR", "unhandled_backend_error", { details });

  res.status(500).json({
    error: "Internal server error.",
    details: error instanceof Error ? error.message : String(error)
  });
});

/* ---------------------------------------------------------------------------
 * Lifecycle (startup + graceful shutdown)
 * --------------------------------------------------------------------------- */

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
