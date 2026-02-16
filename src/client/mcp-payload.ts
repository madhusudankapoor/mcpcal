/* MCP response parsing and tool normalization — MCP plumbing, not AI logic. */

import {
  ToolNameSchema,
  calculatorTools,
  toolInputSchema,
  type CalculatorToolDefinition,
  type ToolExecutionPayload,
  type ToolName
} from "../shared/types.js";
import { isRecord } from "./utils.js";

/* Validates parsed MCP text payload shape ({ok:true}|{ok:false}). */
export function isToolExecutionPayload(value: unknown): value is ToolExecutionPayload {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }

  if (value.ok) {
    return typeof value.result === "number" && Number.isFinite(value.result);
  }

  return typeof value.error === "string" && (value.details === undefined || typeof value.details === "string");
}

/* Defensive validator for tool input schemas from MCP listTools(). */
export function isCalculatorInputSchema(value: unknown): value is CalculatorToolDefinition["inputSchema"] {
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

/* Pulls first text content block from MCP callTool() response. */
export function extractPayloadText(rawResponse: unknown): string | null {
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

/* Parses and validates tool payload embedded by the MCP server. */
export function parseToolPayload(rawResponse: unknown): ToolExecutionPayload | null {
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

/* Maps tool names to operator symbols for display. */
export function operatorForTool(tool: ToolName): string {
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

/* Normalizes listTools() response to our strict shared type. */
export function normalizeDiscoveredTools(rawTools: unknown): CalculatorToolDefinition[] {
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
