/* Learning console trace/logging system — SSE broadcasting + event formatting. */

import type { Response } from "express";
import type { McpConsoleEvent } from "../shared/types.js";
import { isRecord, getString, getNumber, getBoolean } from "./utils.js";

export type LogLevel = "INFO" | "ERROR";

const TRACE_HISTORY_LIMIT = 200;

/* SSE clients currently subscribed to /mcp-events/stream. */
export const traceClients = new Set<Response>();

/* In-memory rolling trace history for the MCP learning console. */
export const traceHistory: McpConsoleEvent[] = [];

let traceSequence = 1;

/* Sends one SSE frame to all connected browsers. */
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

/* Adds a trace item to history and broadcasts it to live subscribers. */
export function publishTrace(trace: Omit<McpConsoleEvent, "id" | "ts">): void {
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

/* Converts backend machine events into user-facing learning explanations. */
function describeTrace(
  level: LogLevel,
  event: string,
  payload: Record<string, unknown>,
  defaultPort: number
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
        summary: `Express server is ready on port ${String(getNumber(payload, "port") ?? defaultPort)}.`,
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
