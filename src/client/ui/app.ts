type ToolName = "add" | "subtract" | "multiply" | "divide";

interface CalculateSuccessResponse {
  result: number;
  expression: string;
}

interface ApiErrorResponse {
  error: string;
  details?: string;
}

interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: object;
}

interface ToolsResponse {
  tools: ToolDefinition[];
}

interface CalculatorState {
  currentInput: string;
  firstOperand: number | null;
  pendingTool: ToolName | null;
  pendingSymbol: string | null;
  awaitingSecondOperand: boolean;
  loading: boolean;
  statusMessage: string;
  expression: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCalculateSuccessResponse(value: unknown): value is CalculateSuccessResponse {
  return (
    isRecord(value) &&
    typeof value.result === "number" &&
    Number.isFinite(value.result) &&
    typeof value.expression === "string"
  );
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return isRecord(value) && typeof value.error === "string" && (value.details === undefined || typeof value.details === "string");
}

function isToolName(value: unknown): value is ToolName {
  return value === "add" || value === "subtract" || value === "multiply" || value === "divide";
}

function isToolsResponse(value: unknown): value is ToolsResponse {
  if (!isRecord(value) || !Array.isArray(value.tools)) {
    return false;
  }

  return value.tools.every((tool) => {
    return (
      isRecord(tool) &&
      isToolName(tool.name) &&
      typeof tool.description === "string" &&
      isRecord(tool.inputSchema)
    );
  });
}

const displayElementRaw = document.getElementById("display");
const expressionElementRaw = document.getElementById("expression-display");
const statusElementRaw = document.getElementById("status");
const buttonElements = Array.from(document.querySelectorAll<HTMLButtonElement>(".btn"));

if (
  !(displayElementRaw instanceof HTMLElement) ||
  !(expressionElementRaw instanceof HTMLElement) ||
  !(statusElementRaw instanceof HTMLElement)
) {
  throw new Error("Calculator UI did not initialize. Required DOM elements are missing.");
}

const displayElement: HTMLElement = displayElementRaw;
const expressionElement: HTMLElement = expressionElementRaw;
const statusElement: HTMLElement = statusElementRaw;

const state: CalculatorState = {
  currentInput: "0",
  firstOperand: null,
  pendingTool: null,
  pendingSymbol: null,
  awaitingSecondOperand: false,
  loading: false,
  statusMessage: "",
  expression: ""
};

function log(event: string, payload: unknown = {}): void {
  console.log(`[ui] ${event}`, payload);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toString();
}

function setStatus(message: string, isError = false): void {
  state.statusMessage = message;
  statusElement.textContent = message;
  statusElement.classList.toggle("error", isError);
}

function setLoading(loading: boolean): void {
  state.loading = loading;
  buttonElements.forEach((button) => {
    button.disabled = loading;
  });
  document.body.classList.toggle("loading", loading);
  if (loading) {
    setStatus("Calculating...");
  } else if (!statusElement.classList.contains("error")) {
    setStatus("");
  }
}

function updateDisplay(): void {
  displayElement.textContent = state.currentInput;
  expressionElement.textContent = state.expression;
}

function clearAll(): void {
  state.currentInput = "0";
  state.firstOperand = null;
  state.pendingTool = null;
  state.pendingSymbol = null;
  state.awaitingSecondOperand = false;
  state.expression = "";
  setStatus("");
  updateDisplay();
  log("clear");
}

function appendDigit(digit: string): void {
  if (state.awaitingSecondOperand) {
    state.currentInput = digit;
    state.awaitingSecondOperand = false;
  } else if (state.currentInput === "0") {
    state.currentInput = digit;
  } else {
    state.currentInput += digit;
  }

  updateDisplay();
}

function appendDecimal(): void {
  if (state.awaitingSecondOperand) {
    state.currentInput = "0.";
    state.awaitingSecondOperand = false;
    updateDisplay();
    return;
  }

  if (!state.currentInput.includes(".")) {
    state.currentInput += ".";
    updateDisplay();
  }
}

async function callCalculate(tool: ToolName, a: number, b: number): Promise<CalculateSuccessResponse> {
  const requestPayload = {
    tool,
    args: { a, b }
  };

  log("calculate_request", requestPayload);
  const response = await fetch("/calculate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestPayload)
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Backend returned a non-JSON response.");
  }

  if (response.ok && isCalculateSuccessResponse(payload)) {
    log("calculate_response_success", payload);
    return payload;
  }

  if (isApiErrorResponse(payload)) {
    log("calculate_response_error", payload);
    throw new Error(payload.details ? `${payload.error} ${payload.details}` : payload.error);
  }

  throw new Error("Unexpected response from backend.");
}

async function executePendingCalculation(nextTool: ToolName | null, nextSymbol: string | null): Promise<void> {
  if (!state.pendingTool || state.firstOperand === null || state.awaitingSecondOperand) {
    state.pendingTool = nextTool;
    state.pendingSymbol = nextSymbol;
    return;
  }

  const secondOperand = Number(state.currentInput);
  if (!Number.isFinite(secondOperand)) {
    setStatus("Second number is invalid.", true);
    return;
  }

  try {
    setLoading(true);
    const result = await callCalculate(state.pendingTool, state.firstOperand, secondOperand);
    state.currentInput = formatNumber(result.result);
    state.firstOperand = result.result;
    state.pendingTool = nextTool;
    state.pendingSymbol = nextSymbol;
    state.awaitingSecondOperand = true;
    state.expression = `${result.expression}`;
    setStatus("");
    updateDisplay();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Calculation failed.";
    setStatus(message, true);
  } finally {
    setLoading(false);
  }
}

async function handleOperator(symbol: string, tool: ToolName): Promise<void> {
  setStatus("");

  if (state.firstOperand === null) {
    const first = Number(state.currentInput);
    if (!Number.isFinite(first)) {
      setStatus("First number is invalid.", true);
      return;
    }
    state.firstOperand = first;
    state.pendingTool = tool;
    state.pendingSymbol = symbol;
    state.awaitingSecondOperand = true;
    state.expression = `${formatNumber(first)} ${symbol}`;
    updateDisplay();
    return;
  }

  if (state.awaitingSecondOperand) {
    state.pendingTool = tool;
    state.pendingSymbol = symbol;
    state.expression = `${formatNumber(state.firstOperand)} ${symbol}`;
    updateDisplay();
    return;
  }

  await executePendingCalculation(tool, symbol);
  if (state.firstOperand !== null) {
    state.expression = `${formatNumber(state.firstOperand)} ${symbol}`;
    updateDisplay();
  }
}

async function handleEquals(): Promise<void> {
  setStatus("");
  if (!state.pendingTool || state.firstOperand === null) {
    return;
  }

  if (state.awaitingSecondOperand) {
    setStatus("Enter the second number before pressing equals.", true);
    return;
  }

  const secondOperand = Number(state.currentInput);
  if (!Number.isFinite(secondOperand)) {
    setStatus("Second number is invalid.", true);
    return;
  }

  try {
    setLoading(true);
    const result = await callCalculate(state.pendingTool, state.firstOperand, secondOperand);
    state.currentInput = formatNumber(result.result);
    state.expression = `${result.expression} =`;
    state.firstOperand = null;
    state.pendingTool = null;
    state.pendingSymbol = null;
    state.awaitingSecondOperand = false;
    setStatus("");
    updateDisplay();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Calculation failed.";
    setStatus(message, true);
  } finally {
    setLoading(false);
  }
}

function bindButtonHandlers(): void {
  buttonElements.forEach((button) => {
    button.addEventListener("click", () => {
      if (state.loading) {
        return;
      }

      const digit = button.dataset.digit;
      if (digit) {
        appendDigit(digit);
        return;
      }

      const action = button.dataset.action;
      if (action === "decimal") {
        appendDecimal();
        return;
      }
      if (action === "clear") {
        clearAll();
        return;
      }
      if (action === "equals") {
        void handleEquals();
        return;
      }

      const tool = button.dataset.tool;
      const symbol = button.dataset.symbol;
      if (tool && symbol && isToolName(tool)) {
        void handleOperator(symbol, tool);
      }
    });
  });
}

async function initializeTools(): Promise<void> {
  try {
    const response = await fetch("/tools");
    const payload: unknown = await response.json();

    if (!response.ok || !isToolsResponse(payload)) {
      throw new Error("Tool discovery failed.");
    }

    const names = new Set(payload.tools.map((tool) => tool.name));
    buttonElements.forEach((button) => {
      const tool = button.dataset.tool;
      if (!tool) {
        return;
      }
      if (!isToolName(tool) || !names.has(tool)) {
        button.disabled = true;
      }
    });

    log("tools_discovered", { tools: payload.tools.map((tool) => tool.name) });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load calculator tools.";
    setStatus(message, true);
  }
}

bindButtonHandlers();
clearAll();
void initializeTools();
