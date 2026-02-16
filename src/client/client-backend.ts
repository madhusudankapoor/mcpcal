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
        explanation:
          "Backend sends the conversation (built by buildConversation()) and tool definitions " +
          "(built by convertMcpToolsToOpenAiFormat()) to the LLM. The LLM will decide whether " +
          "to call tools or respond directly — this is the start of the agentic loop.",
        data: payload
      };

    case "llm_agentic_round": {
      const round = getNumber(payload, "round") ?? 0;
      return {
        level,
        component: "openai",
        event,
        summary: `Agentic loop: starting round ${String(round)}.`,
        explanation:
          round === 1
            ? "Round 1: The LLM sees the user's question for the first time along with the tool menu. " +
              "It will decide whether to call a tool or answer directly."
            : `Round ${String(round)}: The LLM now has tool results from the previous round. ` +
              "It will decide whether more tool calls are needed or if it can produce a final answer.",
        data: payload
      };
    }

    case "llm_sending_messages": {
      const round = getNumber(payload, "round") ?? 0;
      const messageCount = getNumber(payload, "messageCount") ?? 0;
      const snapshot = getString(payload, "conversationSnapshot") ?? "";
      return {
        level,
        component: "openai",
        event,
        summary: `→ SENDING to LLM (round ${String(round)}): ${String(messageCount)} message(s).`,
        explanation:
          "Below is what the backend is sending to the LLM right now. " +
          "Each round the conversation grows — the LLM sees the original question " +
          "PLUS all tool calls and results from previous rounds:\n\n" + snapshot,
        data: payload
      };
    }

    case "llm_received_response": {
      const round = getNumber(payload, "round") ?? 0;
      const hasToolCalls = getBoolean(payload, "hasToolCalls") === true;
      const hasText = getBoolean(payload, "hasText") === true;
      const finishReason = getString(payload, "finishReason") ?? "unknown";
      const snapshot = getString(payload, "responseSnapshot") ?? "";

      let summaryText: string;
      if (hasToolCalls && hasText) {
        summaryText = `← LLM RETURNED (round ${String(round)}): Chain of Thought + tool calls (finish_reason: ${finishReason}).`;
      } else if (hasToolCalls) {
        summaryText = `← LLM RETURNED (round ${String(round)}): tool calls (finish_reason: ${finishReason}).`;
      } else {
        summaryText = `← LLM RETURNED (round ${String(round)}): final text answer (finish_reason: ${finishReason}).`;
      }

      return {
        level,
        component: "openai",
        event,
        summary: summaryText,
        explanation:
          "Below is what the LLM returned. When finish_reason is 'tool_calls', the LLM wants us to " +
          "execute tools and feed results back. When it's 'stop', the LLM is done and returned a " +
          "final answer:\n\n" + snapshot,
        data: payload
      };
    }

    case "llm_tool_results_feeding_back": {
      const round = getNumber(payload, "round") ?? 0;
      const resultCount = getNumber(payload, "resultCount") ?? 0;
      const results = Array.isArray(payload.results) ? (payload.results as string[]).join("\n    ") : "";
      return {
        level,
        component: "openai",
        event,
        summary: `↻ FEEDING BACK ${String(resultCount)} tool result(s) to LLM (after round ${String(round)}).`,
        explanation:
          "The backend executed the tool(s) the LLM requested and is now adding the results " +
          "to the conversation. The LLM will see these results in the next round and decide " +
          "whether to call more tools or produce a final answer:\n\n    " + results,
        data: payload
      };
    }

    case "llm_chain_of_thought": {
      const round = getNumber(payload, "round");
      const thought = getString(payload, "thought") ?? "";
      const preview = thought.length > 80 ? thought.slice(0, 80) + "…" : thought;
      return {
        level,
        component: "openai",
        event,
        summary: `Chain of Thought (round ${String(round ?? "?")}): "${preview}"`,
        explanation:
          "The LLM included text content alongside its tool calls — it is 'thinking out loud' " +
          "about which tools to use and why. This is Chain of Thought reasoning, where the model " +
          "breaks a complex problem into steps before acting.",
        data: payload
      };
    }

    case "llm_tool_selection": {
      const count = getNumber(payload, "count") ?? 0;
      const round = getNumber(payload, "round");
      const roundLabel = round ? ` (round ${String(round)})` : "";

      // Build detailed tool call descriptions with arguments
      const toolDetails = Array.isArray(payload.toolDetails)
        ? (payload.toolDetails as Array<{ name: string; args: Record<string, unknown> }>)
        : [];
      const toolDescriptions = toolDetails.map((td) => {
        const argsStr = Object.entries(td.args).map(([k, v]) => `${k}=${String(v)}`).join(", ");
        return `${td.name}(${argsStr})`;
      });
      const toolListStr = toolDescriptions.length > 0
        ? toolDescriptions.join(", ")
        : (Array.isArray(payload.tools) ? (payload.tools as string[]).join(", ") : "unknown");

      return {
        level,
        component: "openai",
        event,
        summary: `OpenAI selected ${String(count)} tool call(s)${roundLabel}: ${toolListStr}`,
        explanation:
          "The LLM performed intent recognition — it analyzed the user's request and determined " +
          `which tool(s) to call with specific arguments. The LLM extracted numbers from ` +
          "natural language (e.g. 'four times four' → a=4, b=4) and mapped them to the tool's JSON Schema.\n\n" +
          `Tool calls this round:\n    ${toolDescriptions.join("\n    ")}`,
        data: payload
      };
    }

    case "llm_response": {
      const termination = getString(payload, "termination");
      const rounds = getNumber(payload, "rounds") ?? 0;
      const toolCallCount = getNumber(payload, "toolCallCount") ?? 0;
      const finalAnswer = getString(payload, "finalAnswer");
      const answerPreview = finalAnswer
        ? (finalAnswer.length > 120 ? finalAnswer.slice(0, 120) + "…" : finalAnswer)
        : null;

      const terminationExplanation = termination === "safety_limit"
        ? `Safety termination: the agentic loop hit the maximum round limit after ${String(rounds)} round(s) ` +
          `with ${String(toolCallCount)} tool call(s). This prevents infinite loops when the LLM keeps ` +
          "calling tools without converging on an answer."
        : `Natural termination: the LLM decided it has enough information after ${String(rounds)} round(s) ` +
          `and ${String(toolCallCount)} tool call(s). It returned a text response with no further tool calls.` +
          (answerPreview ? `\n\nFinal answer: "${answerPreview}"` : "");

      return {
        level,
        component: "openai",
        event,
        summary: termination === "safety_limit"
          ? `Agentic loop ended (safety limit) after ${String(rounds)} round(s).`
          : `✓ Agentic loop complete after ${String(rounds)} round(s) — LLM produced final answer.`,
        explanation: terminationExplanation,
        data: payload
      };
    }

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
 * ---------------------------------------------------------------------------
 * Human-readable message summarizers for the learning console
 * ---------------------------------------------------------------------------
 */

/**
 * Formats the messages array into a human-readable summary showing exactly
 * what is being sent to the LLM.  This lets learners see how the conversation
 * grows over multiple agentic rounds.
 */
function summarizeMessagesForHumans(messages: ChatCompletionMessageParam[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const content = typeof msg.content === "string" ? msg.content : "[complex content]";
      const preview = content.length > 120 ? content.slice(0, 120) + "…" : content;
      lines.push(`  [SYSTEM] ${preview}`);
    } else if (msg.role === "user") {
      const content = typeof msg.content === "string" ? msg.content : "[complex content]";
      lines.push(`  [USER] "${content}"`);
    } else if (msg.role === "assistant") {
      const assistantMsg = msg as unknown as Record<string, unknown>;
      const textContent = typeof assistantMsg.content === "string" ? assistantMsg.content : null;
      const toolCalls = Array.isArray(assistantMsg.tool_calls) ? assistantMsg.tool_calls : [];

      if (textContent && toolCalls.length > 0) {
        lines.push(`  [ASSISTANT] (thinking) "${textContent}"`);
      }

      if (toolCalls.length > 0) {
        const callSummaries = toolCalls.map((tc: Record<string, unknown>) => {
          const fn = isRecord(tc.function) ? tc.function : {};
          const name = typeof fn.name === "string" ? fn.name : "?";
          const args = typeof fn.arguments === "string" ? fn.arguments : "{}";
          return `${name}(${args})`;
        });
        lines.push(`  [ASSISTANT] → tool calls: ${callSummaries.join(", ")}`);
      } else if (textContent) {
        const preview = textContent.length > 150 ? textContent.slice(0, 150) + "…" : textContent;
        lines.push(`  [ASSISTANT] "${preview}"`);
      }
    } else if (msg.role === "tool") {
      const toolMsg = msg as unknown as Record<string, unknown>;
      const content = typeof toolMsg.content === "string" ? toolMsg.content : "?";
      lines.push(`  [TOOL RESULT] ${content}`);
    }
  }

  return lines.join("\n");
}

/**
 * Formats the LLM response choice into a human-readable summary showing
 * exactly what the LLM returned.
 */
function summarizeLlmResponseForHumans(
  choice: { message: { content?: string | null; tool_calls?: Array<Record<string, unknown>> | null } }
): string {
  const lines: string[] = [];
  const textContent = choice.message.content;
  const toolCalls = choice.message.tool_calls ?? [];

  if (textContent && toolCalls.length > 0) {
    lines.push(`  LLM is thinking: "${textContent}"`);
  }

  if (toolCalls.length > 0) {
    lines.push(`  LLM wants to call ${String(toolCalls.length)} tool(s):`);
    for (const tc of toolCalls) {
      if (tc.type === "function" && isRecord(tc.function)) {
        const fnName = typeof tc.function.name === "string" ? tc.function.name : "?";
        const fnArgs = typeof tc.function.arguments === "string" ? tc.function.arguments : "{}";
        let argsReadable: string;
        try {
          const parsed = JSON.parse(fnArgs) as Record<string, unknown>;
          argsReadable = Object.entries(parsed)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(", ");
        } catch {
          argsReadable = fnArgs;
        }
        lines.push(`    → ${fnName}(${argsReadable})`);
      }
    }
  } else if (textContent) {
    const preview = textContent.length > 200 ? textContent.slice(0, 200) + "…" : textContent;
    lines.push(`  LLM final answer: "${preview}"`);
  } else {
    lines.push("  LLM returned empty response.");
  }

  return lines.join("\n");
}

/**
 * ---------------------------------------------------------------------------
 * AI Concept Helpers
 * ---------------------------------------------------------------------------
 * Each function below isolates one AI/LLM concept so that reading the code
 * teaches you how Tool Calling, Agentic Loops, Chain of Thought, and MCP
 * protocol work together. The /chat route orchestrates them in sequence.
 * ---------------------------------------------------------------------------
 */

/**
 * ## AI Concept: Prompt Engineering — Building a Conversation
 *
 * Every LLM interaction starts by constructing a **messages array** that
 * frames the conversation.  The first message uses `role: "system"` to set
 * the LLM's identity, capabilities, and constraints.  The second uses
 * `role: "user"` to carry the human's input.
 *
 * **Why this matters:**
 * - The system prompt defines *what the LLM is allowed to do* (use tools,
 *   only do math) and *how it should respond* (plain text, no LaTeX).
 * - Prompt engineering is the practice of crafting these instructions so
 *   the model behaves predictably.  Small wording changes can dramatically
 *   alter output quality.
 * - The `tools` parameter (set later in the API call) tells the LLM *which*
 *   functions exist; the system prompt tells it *when and how* to use them.
 *
 * @param userMessage - The natural-language message from the browser.
 * @returns A two-element messages array ready for the OpenAI Chat API.
 */
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

/**
 * ## AI Concept: Tool Calling — Bridging MCP and OpenAI Schemas
 *
 * LLMs with **tool calling** (a.k.a. function calling) can decide, mid-
 * conversation, to invoke an external function instead of generating text.
 * To do this the LLM needs a **tool registry** — a list of available
 * functions with their names, descriptions, and JSON Schema parameters.
 *
 * **How it works under the hood:**
 * 1. MCP servers expose tools via `listTools()` with their own schema format.
 * 2. This function **translates** MCP tool definitions into OpenAI's
 *    `ChatCompletionTool` format so the LLM can understand them.
 * 3. When the LLM decides a tool is needed, it returns a `tool_calls` array
 *    with the function name and JSON arguments — it does NOT execute anything.
 * 4. Our code then executes the tool via MCP and feeds the result back.
 *
 * **MCP ↔ OpenAI schema mapping:**
 * ```
 *   MCP tool.inputSchema          →  OpenAI function.parameters
 *   MCP tool.name                 →  OpenAI function.name
 *   MCP tool.description          →  OpenAI function.description
 * ```
 *
 * The LLM uses the description + schema to decide *intent recognition*
 * (which tool to call) and *parameter extraction* (what arguments to pass).
 *
 * @returns Array of tool definitions in OpenAI's function-calling format.
 */
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

/**
 * ## AI Concept: Tool Execution Pipeline — Single Tool Call
 *
 * After the LLM selects a tool, this function handles the **execution
 * pipeline** for one tool call:
 *
 * 1. **Parse** — JSON.parse the arguments string the LLM generated.
 * 2. **Validate** — Use Zod schemas to verify the tool name and args are
 *    legitimate (the LLM can hallucinate invalid function names or args).
 * 3. **Execute** — Send the validated call to the MCP server via `callTool()`.
 * 4. **Parse result** — Extract the typed payload from the MCP response.
 *
 * **Why errors are returned to the LLM, not thrown:**
 * If a tool call fails (bad args, MCP error), we package the error as a
 * `role: "tool"` message and send it back to the LLM.  This lets the LLM
 * *self-correct* — it can retry with different arguments or explain the
 * failure to the user.  Throwing would abort the entire agentic loop.
 *
 * @param toolCall   - A single function-type tool call from the LLM response.
 * @param mcp        - The connected MCP client for executing tool calls.
 * @returns An object with the ChatToolCall record and the tool message to
 *          append to the conversation.
 */
async function executeSingleToolCall(
  toolCall: { id: string; function: { name: string; arguments: string } },
  mcp: Client
): Promise<{
  chatToolCall: ChatToolCall;
  toolMessage: ChatCompletionMessageParam;
}> {
  const fnName = toolCall.function.name;

  // Step 1: Parse the LLM-generated argument string into an object.
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

  // Step 2: Validate tool name and args against our Zod schemas.
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

  // Step 3: Execute via MCP callTool().
  log("INFO", "mcp_phase_3_tool_execution_started", {
    tool: nameResult.data,
    args: argsResult.data
  });

  const rawToolResponse = await mcp.callTool({
    name: nameResult.data,
    arguments: argsResult.data
  });

  // Step 4: Parse the typed payload from the MCP response.
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

/**
 * ## AI Concept: Parallel Tool Calling — Batch Execution
 *
 * Modern LLMs can request **multiple tool calls in a single response**.
 * For example, to compute `(2 + 3) * (4 + 5)`, the LLM might request
 * both `add(2, 3)` and `add(4, 5)` simultaneously in one round, then
 * `multiply` their results in the next round.
 *
 * This function iterates over a batch of tool calls from one LLM response
 * and executes each one via `executeSingleToolCall`.  All results are
 * appended to the conversation as individual `role: "tool"` messages so
 * the LLM can see every outcome in the next round.
 *
 * **Note:** Calls are currently executed sequentially (one MCP callTool at
 * a time) for simplicity.  In production you could use `Promise.all()` for
 * true parallel execution when the MCP server supports concurrent calls.
 *
 * @param functionCalls - Array of function-type tool calls from the LLM.
 * @param mcp           - The connected MCP client.
 * @returns Arrays of ChatToolCall records and tool messages for the conversation.
 */
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

/**
 * ## AI Concept: The Agentic Loop — Observe → Think → Act
 *
 * This is the **core AI pattern** that turns a single LLM call into an
 * autonomous agent.  Instead of one request/response, we loop:
 *
 * ```
 *   ┌─────────────────────────────────────────────────────┐
 *   │                   AGENTIC LOOP                      │
 *   │                                                     │
 *   │  ┌──────────┐    ┌──────────┐    ┌──────────┐      │
 *   │  │ OBSERVE  │───▶│  THINK   │───▶│   ACT    │      │
 *   │  │ (tool    │    │ (LLM     │    │ (execute │      │
 *   │  │ results) │    │ reasons) │    │ tools)   │      │
 *   │  └──────────┘    └──────────┘    └──────────┘      │
 *   │       ▲                               │             │
 *   │       └───────────────────────────────┘             │
 *   │              loop until done                        │
 *   └─────────────────────────────────────────────────────┘
 *
 *   Round 1: User asks "what is 4 * 4 * 4?"
 *            LLM thinks → calls multiply(4, 4)
 *   Round 2: Tool returns 16
 *            LLM thinks → calls multiply(16, 4)
 *   Round 3: Tool returns 64
 *            LLM thinks → no more tools needed → returns "64"
 * ```
 *
 * **Two ways the loop ends:**
 * - **Natural termination:** The LLM returns a message with no `tool_calls`,
 *   meaning it has enough information to answer the user.
 * - **Safety termination:** We hit `maxRounds` to prevent infinite loops
 *   (e.g., if the LLM keeps calling tools without converging on an answer).
 *
 * **How this differs from a single LLM call:**
 * A single call can only use information already in the prompt.  The agentic
 * loop lets the LLM *gather new information* (via tools) across multiple
 * rounds, building up context until it can produce a final answer.  This is
 * what makes it an "agent" rather than a simple chatbot.
 *
 * @param messages  - The conversation so far (system + user messages).
 * @param tools     - OpenAI-format tool definitions for function calling.
 * @param mcp       - The connected MCP client for executing tool calls.
 * @param maxRounds - Safety limit on the number of LLM round-trips.
 * @returns The final ChatResponse with the LLM's answer and all tool calls made.
 */
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

    /**
     * Log what we're SENDING to the LLM this round — the full conversation
     * so far, including any tool results from previous rounds.
     */
    log("INFO", "llm_sending_messages", {
      round,
      messageCount: messages.length,
      conversationSnapshot: summarizeMessagesForHumans(messages)
    });

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
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

    /**
     * Log what the LLM RETURNED — whether it's tool calls, text, or both.
     * This is the most important log for understanding the agentic flow.
     */
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

    /**
     * Chain of Thought: If the LLM includes text content alongside tool
     * calls, it is "thinking out loud" — reasoning about which tools to
     * use.  We log this as chain-of-thought for the learning console.
     */
    if (choice.message.content && choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      log("INFO", "llm_chain_of_thought", {
        round,
        thought: choice.message.content
      });
    }

    /**
     * Natural termination: no tool calls means the LLM is done reasoning
     * and has produced its final answer.
     */
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

    // Append the assistant message (with tool_calls) to conversation history.
    messages.push(choice.message);

    // Execute all tool calls in this batch and collect results.
    const { chatToolCalls, toolMessages } = await executeToolCallsFromLlm(functionCalls, mcp);
    allToolCalls.push(...chatToolCalls);

    /**
     * Log what tool results we're FEEDING BACK to the LLM before the next
     * round.  This shows the observe→think→act cycle completing.
     */
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

  /**
   * Safety termination: we hit maxRounds without the LLM producing a final
   * text-only response.  Return what we have so far.
   */
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
  // Skip logging for health-check probes to avoid console noise.
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
 * Lightweight health probe for Render (or any orchestrator).
 */
app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

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
 *
 * This route is a thin **5-step orchestrator** that delegates all AI logic
 * to the educational helper functions above.  Reading those functions in
 * order teaches you Prompt Engineering, Tool Calling, Tool Execution,
 * Parallel Batch Execution, and the Agentic Loop.
 */
app.post(
  "/chat",
  async (
    req: Request,
    res: Response<ChatResponse | ErrorResponse>,
    next: NextFunction
  ): Promise<void> => {
    // Step 1: Validate the incoming request.
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
      // Step 2: Build the conversation (system prompt + user message).
      const messages = buildConversation(message);

      // Step 3: Convert MCP tool definitions to OpenAI format.
      const tools = convertMcpToolsToOpenAiFormat();

      log("INFO", "llm_request", { message, toolCount: tools.length });

      // Step 4: Run the agentic loop (observe → think → act cycle).
      const chatResponse = await runAgenticLoop(messages, tools, mcpClient, 10);

      // Step 5: Return the response.
      res.json(chatResponse);
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
