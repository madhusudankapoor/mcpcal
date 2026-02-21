/* Learning console trace/logging system — per-session SSE broadcasting + event formatting. */

import type { Response } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import type { McpConsoleEvent } from "../shared/types.js";
import { isRecord, getString, getNumber, getBoolean } from "./utils.js";

export type LogLevel = "INFO" | "ERROR";

const TRACE_HISTORY_LIMIT = 200;

/* Per-request session context so publishTrace() routes events to the correct browser tab. */
export const sessionStorage = new AsyncLocalStorage<string>();

/* Per-session SSE clients and rolling trace history. */
const sessionClients = new Map<string, Set<Response>>();
const sessionTraces  = new Map<string, McpConsoleEvent[]>();

let traceSequence = 1;

/* ── Session management helpers ──────────────────────────────────────────── */

/** Register an SSE response for a session. */
export function addSessionClient(sessionId: string, res: Response): void {
  let clients = sessionClients.get(sessionId);
  if (!clients) {
    clients = new Set();
    sessionClients.set(sessionId, clients);
  }
  clients.add(res);
}

/** Unregister an SSE response; cleans up session data when last client leaves. */
export function removeSessionClient(sessionId: string, res: Response): void {
  const clients = sessionClients.get(sessionId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) {
      sessionClients.delete(sessionId);
      sessionTraces.delete(sessionId);
    }
  }
}

/** All SSE responses across every session (for shutdown). */
export function getAllClients(): Response[] {
  const all: Response[] = [];
  for (const clients of sessionClients.values()) {
    for (const client of clients) {
      all.push(client);
    }
  }
  return all;
}

/** Tears down all session state (for shutdown). */
export function clearAllSessions(): void {
  sessionClients.clear();
  sessionTraces.clear();
}

/** Returns trace history for one session. */
export function getSessionTraces(sessionId: string): McpConsoleEvent[] {
  return sessionTraces.get(sessionId) ?? [];
}

/**
 * Sends a "clear" SSE event to one session and wipes its trace history.
 * Called at the start of every /calculate or /chat so each execution gets a clean console.
 */
export function clearSessionTrace(sessionId: string): void {
  sessionTraces.delete(sessionId);
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  const frame = `event: clear\ndata: {}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

/* ── Trace publishing ────────────────────────────────────────────────────── */

/** Sends one SSE trace frame to a session's connected browsers. */
function writeTraceToSessionClients(trace: McpConsoleEvent, sessionId: string): void {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  const frame = `event: trace\ndata: ${JSON.stringify(trace)}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

/**
 * Adds a trace to the active session's history and broadcasts it.
 * Session is read from AsyncLocalStorage or the explicit targetSessionId param.
 * Traces without a session (e.g. startup) are silently skipped — they still
 * appear in server stdout via log().
 */
export function publishTrace(trace: Omit<McpConsoleEvent, "id" | "ts">, targetSessionId?: string): void {
  const sessionId = targetSessionId ?? sessionStorage.getStore();

  const nextTrace: McpConsoleEvent = {
    id: traceSequence,
    ts: new Date().toISOString(),
    ...trace
  };
  traceSequence += 1;

  /* No session context (e.g. startup) → skip storage and broadcast. */
  if (!sessionId) return;

  let history = sessionTraces.get(sessionId);
  if (!history) {
    history = [];
    sessionTraces.set(sessionId, history);
  }
  history.push(nextTrace);
  if (history.length > TRACE_HISTORY_LIMIT) {
    history.shift();
  }

  writeTraceToSessionClients(nextTrace, sessionId);
}

/* ── Converts backend machine events into user-facing learning explanations ─ */

function describeTrace(
  level: LogLevel,
  event: string,
  payload: Record<string, unknown>,
  defaultPort: number
): Omit<McpConsoleEvent, "id" | "ts"> | null {
  void defaultPort;

  switch (event) {
    // ── MCP setup (one message each) ─────────────────────────────────────────

    case "mcp_phase_1_handshake_complete":
      return {
        level,
        component: "mcp-protocol",
        event,
        summary: "MCP handshake complete.",
        explanation: "Backend spawned the calculator server process and negotiated protocol capabilities over stdio. Tool calls can now be sent.",
        data: payload
      };

    case "mcp_phase_2_discovery_complete": {
      const toolCount = getNumber(payload, "toolCount") ?? 0;
      const toolNames = Array.isArray(payload.toolNames)
        ? (payload.toolNames as string[]).join(", ")
        : "";
      return {
        level,
        component: "mcp-protocol",
        event,
        summary: `MCP tools discovered: ${toolNames || String(toolCount) + " tool(s)"}.`,
        explanation: "listTools() returned tool definitions with JSON Schema. These definitions are sent to the LLM so it knows what functions it can call.",
        data: payload
      };
    }

    // ── Direct MCP tool execution (button clicks) ─────────────────────────────

    case "mcp_phase_3_tool_execution_response": {
      const isError = getBoolean(payload, "isError") === true;
      const tool    = getString(payload, "tool") ?? "unknown";
      const args    = isRecord(payload.args) ? payload.args : {};
      const a       = typeof args.a === "number" ? args.a : "?";
      const b       = typeof args.b === "number" ? args.b : "?";
      const result  = isRecord(payload.parsedResult) && payload.parsedResult.ok === true
        ? String(payload.parsedResult.result)
        : null;

      return {
        level,
        component: "mcp-calculator-server",
        event,
        summary: isError
          ? `MCP: ${tool}(${String(a)}, ${String(b)}) → error`
          : `MCP: ${tool}(${String(a)}, ${String(b)}) = ${result ?? "?"}`,
        explanation: isError
          ? "The MCP server returned an error for this tool call."
          : "The MCP server executed the tool and returned a typed JSON result.",
        data: payload
      };
    }

    // ── Errors ────────────────────────────────────────────────────────────────

    case "request_validation_failed":
      return {
        level,
        component: "client-backend",
        event,
        summary: "Validation error: request blocked before reaching MCP.",
        explanation: "Zod rejected the request payload at runtime. This prevents malformed arguments from being sent to the MCP server.",
        data: payload
      };

    case "unhandled_backend_error":
      return {
        level: "ERROR",
        component: "client-backend",
        event,
        summary: "Backend error.",
        explanation: "An unhandled error was caught by Express error middleware.",
        data: payload
      };

    case "startup_failed":
      return {
        level: "ERROR",
        component: "client-backend",
        event,
        summary: "Startup failed — server could not initialise.",
        explanation: "MCP connection or tool discovery failed during startup.",
        data: payload
      };

    // ── AI / agentic loop ─────────────────────────────────────────────────────

    case "llm_request": {
      // Merged entry point: replaces the separate http_request_started POST /chat event.
      const message   = getString(payload, "message") ?? "";
      const toolCount = getNumber(payload, "toolCount") ?? 0;
      const snapshot  = getString(payload, "conversationSnapshot") ?? "";
      const preview   = message.length > 80 ? message.slice(0, 80) + "…" : message;
      return {
        level,
        component: "openai",
        event,
        summary: `Chat: "${preview}" → OpenAI with ${String(toolCount)} tools.`,
        explanation:
          "The user's message is wrapped in a conversation (system prompt + user turn) and sent to the LLM " +
          "alongside the MCP tool definitions. The LLM will decide whether to call a tool or answer directly — " +
          "this is the start of the agentic loop.",
        rawPayload: snapshot,
        data: payload
      };
    }

    case "llm_sending_messages": {
      const round        = getNumber(payload, "round") ?? 0;
      const messageCount = getNumber(payload, "messageCount") ?? 0;
      const snapshot     = getString(payload, "conversationSnapshot") ?? "";
      return {
        level,
        component: "openai",
        event,
        summary: `→ Round ${String(round)}: sending ${String(messageCount)} message(s) to LLM.`,
        explanation:
          "Each round the conversation grows — the LLM sees the original question plus all prior tool calls and results.",
        rawPayload: snapshot,
        data: payload
      };
    }

    case "llm_received_response": {
      const round        = getNumber(payload, "round") ?? 0;
      const hasToolCalls = getBoolean(payload, "hasToolCalls") === true;
      const hasText      = getBoolean(payload, "hasText") === true;
      const finishReason = getString(payload, "finishReason") ?? "unknown";
      const snapshot     = getString(payload, "responseSnapshot") ?? "";

      const label = hasToolCalls && hasText
        ? "chain-of-thought + tool calls"
        : hasToolCalls
          ? "tool calls"
          : "final answer";

      return {
        level,
        component: "openai",
        event,
        summary: `← Round ${String(round)}: LLM returned ${label} (finish_reason: ${finishReason}).`,
        explanation:
          "finish_reason='tool_calls' means the LLM wants to invoke tools before answering. " +
          "finish_reason='stop' means the LLM is done and produced a final answer.",
        rawPayload: snapshot,
        data: payload
      };
    }

    case "llm_chain_of_thought": {
      const round   = getNumber(payload, "round");
      const thought = getString(payload, "thought") ?? "";
      const preview = thought.length > 120 ? thought.slice(0, 120) + "…" : thought;
      return {
        level,
        component: "openai",
        event,
        summary: `Chain of Thought (round ${String(round ?? "?")}): "${preview}"`,
        explanation:
          "The LLM included reasoning text alongside its tool calls — it is thinking out loud before acting. " +
          "This is Chain of Thought: the model breaks a complex problem into steps rather than jumping straight to an answer.",
        data: payload
      };
    }

    case "llm_tool_selection": {
      const count   = getNumber(payload, "count") ?? 0;
      const round   = getNumber(payload, "round");
      const toolDetails = Array.isArray(payload.toolDetails)
        ? (payload.toolDetails as Array<{ name: string; args: Record<string, unknown> }>)
        : [];
      const calls = toolDetails.map((td) => {
        const argsStr = Object.entries(td.args).map(([k, v]) => `${k}=${String(v)}`).join(", ");
        return `${td.name}(${argsStr})`;
      });
      const callsStr = calls.length > 0
        ? calls.join(", ")
        : (Array.isArray(payload.tools) ? (payload.tools as string[]).join(", ") : "unknown");

      return {
        level,
        component: "openai",
        event,
        summary: `LLM selected ${String(count)} tool call(s) (round ${String(round ?? "?")}): ${callsStr}`,
        explanation:
          "The LLM performed intent recognition — it extracted numbers from natural language " +
          "(e.g. 'four times four' → a=4, b=4) and matched them to the tool's JSON Schema. " +
          "These calls will be executed via MCP and the results fed back in the next round.",
        data: payload
      };
    }

    case "llm_tool_results_feeding_back": {
      const round       = getNumber(payload, "round") ?? 0;
      const resultCount = getNumber(payload, "resultCount") ?? 0;
      const results     = Array.isArray(payload.results) ? (payload.results as string[]).join("\n") : "";
      return {
        level,
        component: "openai",
        event,
        summary: `Round ${String(round)}: feeding ${String(resultCount)} tool result(s) back to LLM.`,
        explanation:
          "Tool results are appended to the conversation as tool-role messages. " +
          "The LLM will read them in the next round and decide whether to call more tools or produce a final answer.",
        rawPayload: results || undefined,
        data: payload
      };
    }

    case "llm_response": {
      const termination  = getString(payload, "termination");
      const rounds       = getNumber(payload, "rounds") ?? 0;
      const toolCallCount = getNumber(payload, "toolCallCount") ?? 0;
      const finalAnswer  = getString(payload, "finalAnswer");
      const answerPreview = finalAnswer
        ? (finalAnswer.length > 120 ? finalAnswer.slice(0, 120) + "…" : finalAnswer)
        : null;

      return {
        level,
        component: "openai",
        event,
        summary: termination === "safety_limit"
          ? `Agentic loop stopped (safety limit) after ${String(rounds)} round(s), ${String(toolCallCount)} tool call(s).`
          : `Agentic loop done — ${String(rounds)} round(s), ${String(toolCallCount)} tool call(s).`,
        explanation: termination === "safety_limit"
          ? "The loop hit the maximum round cap without the LLM converging on a text answer. This prevents infinite tool-calling."
          : `The LLM stopped calling tools and returned a final text answer.${answerPreview ? ` "${answerPreview}"` : ""}`,
        data: payload
      };
    }

    // Suppress all other events (infrastructure noise)
    default:
      return null;
  }
}

/* Structured backend logger + learning-trace publisher. */
export function log(level: LogLevel, event: string, payload: Record<string, unknown> = {}, defaultPort = 3000): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: "client-backend",
      event,
      ...payload
    })
  );

  const trace = describeTrace(level, event, payload, defaultPort);
  if (trace) {
    publishTrace(trace);
  }
}
