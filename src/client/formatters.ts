/* Human-readable message summarizers for the learning console. */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { isRecord } from "./utils.js";

/* Formats the messages array into a human-readable snapshot for trace logs. */
export function summarizeMessagesForHumans(messages: ChatCompletionMessageParam[]): string {
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

/* Formats an LLM response choice into a human-readable summary. */
export function summarizeLlmResponseForHumans(
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
