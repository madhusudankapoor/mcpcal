/**
 * UI-side tool and trace types.
 *
 * These mirror backend/shared contracts so the browser can validate responses
 * at runtime and explain the MCP flow with typed confidence.
 */
type ToolName = "add" | "subtract" | "multiply" | "divide";
type TraceLevel = "INFO" | "ERROR";
type TraceComponent = "ui" | "client-backend" | "mcp-calculator-server" | "mcp-protocol" | "openai";

interface CalculateSuccessResponse {
  result      : number;
  expression  : string;
}

interface ApiErrorResponse {
  error    : string;
  details? : string;
}


interface ToolDefinition {
  name         : ToolName;
  description  : string;
  inputSchema  : object;
}

interface ToolsResponse {
  tools : ToolDefinition[];
}

interface McpConsoleEvent {
  id           : number;
  ts           : string;
  level        : TraceLevel;
  component    : TraceComponent;
  event        : string;
  summary      : string;
  explanation  : string;
  rawPayload?  : string;
  data?        : Record<string, unknown>;
}

interface McpConsoleEventsResponse {
  events : McpConsoleEvent[];
}

interface ChatToolCall {
  tool    : string;
  args    : Record<string, unknown>;
  result? : unknown;
  error?  : string;
}

interface ChatResponse {
  response  : string;
  toolCalls : ChatToolCall[];
}

interface CalculatorState {
  currentInput          : string;
  firstOperand          : number | null;
  pendingTool           : ToolName | null;
  pendingSymbol         : string | null;
  awaitingSecondOperand : boolean;
  loading               : boolean;
  statusMessage         : string;
  expression            : string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTraceLevel(value: unknown): value is TraceLevel {
  return value === "INFO" || value === "ERROR";
}

function isTraceComponent(value: unknown): value is TraceComponent {
  return value === "ui" || value === "client-backend" || value === "mcp-calculator-server" || value === "mcp-protocol" || value === "openai";
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

function isChatResponse(value: unknown): value is ChatResponse {
  return (
    isRecord(value) &&
    typeof value.response === "string" &&
    Array.isArray(value.toolCalls)
  );
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

function isMcpConsoleEvent(value: unknown): value is McpConsoleEvent {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.ts === "string" &&
    isTraceLevel(value.level) &&
    isTraceComponent(value.component) &&
    typeof value.event === "string" &&
    typeof value.summary === "string" &&
    typeof value.explanation === "string" &&
    (value.rawPayload === undefined || typeof value.rawPayload === "string") &&
    (value.data === undefined || isRecord(value.data))
  );
}

function isMcpConsoleEventsResponse(value: unknown): value is McpConsoleEventsResponse {
  return isRecord(value) && Array.isArray(value.events) && value.events.every((event) => isMcpConsoleEvent(event));
}

function componentLabel(component: TraceComponent): string {
  switch (component) {
    case "ui":
      return "UI";
    case "client-backend":
      return "Backend";
    case "mcp-calculator-server":
      return "MCP Server";
    case "mcp-protocol":
      return "Protocol";
    case "openai":
      return "OpenAI";
    default:
      return "Unknown";
  }
}

function formatTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return isoTimestamp;
  }
  return date.toLocaleTimeString([], { hour12: false });
}

/**
 * Capture all DOM dependencies once during bootstrap.
 * We aggressively type-check these nodes before use.
 */
const displayElementRaw          = document.getElementById("display");
const expressionElementRaw       = document.getElementById("expression-display");
const statusElementRaw           = document.getElementById("status");
const consoleListRaw             = document.getElementById("console-list");
const consoleConnectionRaw       = document.getElementById("console-connection");
const consoleClearRaw            = document.getElementById("console-clear");
const buttonElements             = Array.from(document.querySelectorAll<HTMLButtonElement>(".btn"));

if (
  !(displayElementRaw instanceof HTMLElement) ||
  !(expressionElementRaw instanceof HTMLElement) ||
  !(statusElementRaw instanceof HTMLElement) ||
  !(consoleListRaw instanceof HTMLUListElement) ||
  !(consoleConnectionRaw instanceof HTMLElement) ||
  !(consoleClearRaw instanceof HTMLButtonElement)
) {
  throw new Error("Calculator UI did not initialize. Required DOM elements are missing.");
}

const displayElement             : HTMLElement      = displayElementRaw;
const expressionElement          : HTMLElement      = expressionElementRaw;
const statusElement              : HTMLElement      = statusElementRaw;
const consoleListElement         : HTMLUListElement  = consoleListRaw;
const consoleConnectionElement   : HTMLElement      = consoleConnectionRaw;
const consoleClearButton         : HTMLButtonElement = consoleClearRaw;

const chatInputRaw               = document.getElementById("chat-input");
const chatSendRaw                = document.getElementById("chat-send");
const chatResponseRaw            = document.getElementById("chat-response");

if (
  !(chatInputRaw instanceof HTMLInputElement) ||
  !(chatSendRaw instanceof HTMLButtonElement) ||
  !(chatResponseRaw instanceof HTMLElement)
) {
  throw new Error("Chat panel DOM elements are missing.");
}

const chatInputElement           : HTMLInputElement  = chatInputRaw;
const chatSendButton             : HTMLButtonElement = chatSendRaw;
const chatResponseElement        : HTMLElement       = chatResponseRaw;

const MAX_CONSOLE_ENTRIES    = 120;
const UI_TRACE_OFFSET        = 1_000_000;
let   seenTraceIds           = new Set<number>();

/* Unique session ID per browser tab — isolates traces from other users. */
const sessionId: string = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
let uiTraceCounter           = 1;
let streamState              : "connecting" | "connected" | "disconnected" = "connecting";
let traceStream              : EventSource | null                          = null;

const state: CalculatorState = {
  currentInput          : "0",
  firstOperand          : null,
  pendingTool           : null,
  pendingSymbol         : null,
  awaitingSecondOperand : false,
  loading               : false,
  statusMessage         : "",
  expression            : ""
};

function log(event: string, payload: unknown = {}): void {
  console.log(`[ui] ${event}`, payload);
}

/**
 * Updates the stream connectivity badge shown in the learning console header.
 */
function setStreamState(nextState: "connecting" | "connected" | "disconnected"): void {
  streamState = nextState;
  consoleConnectionElement.textContent =
    nextState === "connected" ? "Live" : nextState === "connecting" ? "Connecting..." : "Disconnected";
  consoleConnectionElement.classList.remove("connected", "connecting", "disconnected");
  consoleConnectionElement.classList.add(nextState);
}

/**
 * Renders one learning event card in the console list.
 */
function appendConsoleEvent(trace: McpConsoleEvent): void {
  if (seenTraceIds.has(trace.id)) {
    return;
  }
  seenTraceIds.add(trace.id);

  const listItem      = document.createElement("li");
  listItem.className = `console-entry${trace.level === "ERROR" ? " error" : ""}`;

  const meta      = document.createElement("p");
  meta.className = "console-meta";

  const time      = document.createElement("span");
  time.className = "console-time";
  time.textContent = formatTime(trace.ts);

  const component      = document.createElement("span");
  component.className = "console-component";
  component.textContent = componentLabel(trace.component);

  const eventLabel      = document.createElement("span");
  eventLabel.className = "console-event";
  eventLabel.textContent = trace.event;

  meta.append(time, component, eventLabel);

  const summary      = document.createElement("p");
  summary.className = "console-summary";
  summary.textContent = trace.summary;

  const explanation      = document.createElement("p");
  explanation.className = "console-explanation";
  explanation.textContent = trace.explanation;

  listItem.append(meta, summary, explanation);

  if (trace.rawPayload) {
    const pre      = document.createElement("pre");
    pre.className = "console-payload";
    pre.textContent = trace.rawPayload;
    listItem.append(pre);
  }
  consoleListElement.append(listItem);

  while (consoleListElement.children.length > MAX_CONSOLE_ENTRIES) {
    if (consoleListElement.firstElementChild) {
      consoleListElement.removeChild(consoleListElement.firstElementChild);
    }
  }

  consoleListElement.scrollTop = consoleListElement.scrollHeight;
}

function createUiTrace(
  event: string,
  summary: string,
  explanation: string,
  level: TraceLevel = "INFO",
  data?: unknown
): McpConsoleEvent {
  const trace: McpConsoleEvent = {
    id           : UI_TRACE_OFFSET + uiTraceCounter,
    ts           : new Date().toISOString(),
    level,
    component    : "ui",
    event,
    summary,
    explanation,
    data         : isRecord(data) ? data : undefined
  };
  uiTraceCounter += 1;
  return trace;
}

function emitUiTrace(
  event: string,
  summary: string,
  explanation: string,
  level: TraceLevel = "INFO",
  data?: unknown
): void {
  const trace = createUiTrace(event, summary, explanation, level, data);
  appendConsoleEvent(trace);
  log(event, data ?? {});
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toString();
}

function setStatus(message: string, isError = false): void {
  state.statusMessage = message;
  statusElement.textContent = message;
  statusElement.classList.toggle("error", isError);
}

/**
 * Disables interactive controls while request is in-flight.
 */
function setLoading(loading: boolean): void {
  state.loading = loading;
  buttonElements.forEach((button) => {
    button.disabled = loading;
  });
  consoleClearButton.disabled = loading;
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

/**
 * Clears all UI-managed calculator state.
 * MCP server is intentionally stateless and is not reset here.
 */
function clearAll(): void {
  state.currentInput          = "0";
  state.firstOperand          = null;
  state.pendingTool           = null;
  state.pendingSymbol         = null;
  state.awaitingSecondOperand = false;
  state.expression            = "";
  setStatus("");
  updateDisplay();
  emitUiTrace(
    "ui_state_cleared",
    "Calculator state reset in the browser.",
    "UI owns first/second operand state. MCP server stays stateless between requests."
  );
}

function appendDigit(digit: string): void {
  if (state.awaitingSecondOperand) {
    state.currentInput          = digit;
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
    state.currentInput          = "0.";
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
  /**
   * Browser -> backend payload.
   * Backend will validate this with Zod before forwarding to MCP.
   */
  const requestPayload = {
    tool,
    args: { a, b }
  };

  emitUiTrace(
    "ui_calculate_request_sent",
    `UI -> Backend: POST /calculate for ${tool}(${String(a)}, ${String(b)}).`,
    "This starts Phase 3. Backend validates payload, then forwards it as MCP callTool().",
    "INFO",
    requestPayload
  );

  const response = await fetch("/calculate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": sessionId
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
    emitUiTrace(
      "ui_calculate_response_success",
      `Backend -> UI: received result ${String(payload.result)}.`,
      "UI updates display only after typed response validation succeeds.",
      "INFO",
      payload
    );
    return payload;
  }

  if (isApiErrorResponse(payload)) {
    emitUiTrace(
      "ui_calculate_response_error",
      "Backend returned a typed error response.",
      "Errors from validation or MCP tool execution are shown to users in clear text.",
      "ERROR",
      payload
    );
    throw new Error(payload.details ? `${payload.error} ${payload.details}` : payload.error);
  }

  throw new Error("Unexpected response from backend.");
}

async function executePendingCalculation(nextTool: ToolName | null, nextSymbol: string | null): Promise<void> {
  /**
   * When user chains operators (e.g., 2 + 3 *), we resolve the pending call
   * and then stage the next operator.
   */
  if (!state.pendingTool || state.firstOperand === null || state.awaitingSecondOperand) {
    state.pendingTool   = nextTool;
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
    state.currentInput          = formatNumber(result.result);
    state.firstOperand          = result.result;
    state.pendingTool           = nextTool;
    state.pendingSymbol         = nextSymbol;
    state.awaitingSecondOperand = true;
    state.expression            = `${result.expression}`;
    setStatus("");
    updateDisplay();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Calculation failed.";
    setStatus(message, true);
    emitUiTrace(
      "ui_calculation_failed",
      "Calculation failed and error was shown.",
      "Failure can come from backend validation or MCP tool error payloads.",
      "ERROR",
      { message }
    );
  } finally {
    setLoading(false);
    void checkDailyLimit();
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
    state.firstOperand          = first;
    state.pendingTool           = tool;
    state.pendingSymbol         = symbol;
    state.awaitingSecondOperand = true;
    state.expression            = `${formatNumber(first)} ${symbol}`;
    updateDisplay();
    emitUiTrace(
      "ui_operator_selected",
      `Operator selected: ${symbol}.`,
      "UI keeps local state until it has both operands and is ready to request MCP execution.",
      "INFO",
      { firstOperand: first, tool }
    );
    return;
  }

  if (state.awaitingSecondOperand) {
    state.pendingTool   = tool;
    state.pendingSymbol = symbol;
    state.expression    = `${formatNumber(state.firstOperand)} ${symbol}`;
    updateDisplay();
    emitUiTrace(
      "ui_operator_updated",
      `Operator changed to ${symbol} before second operand entry.`,
      "No MCP call needed yet because the second operand is still pending."
    );
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
    state.currentInput          = formatNumber(result.result);
    state.expression            = `${result.expression} =`;
    state.firstOperand          = null;
    state.pendingTool           = null;
    state.pendingSymbol         = null;
    state.awaitingSecondOperand = false;
    setStatus("");
    updateDisplay();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Calculation failed.";
    setStatus(message, true);
    emitUiTrace(
      "ui_equals_failed",
      "Equals operation failed.",
      "UI preserved state and surfaced the backend/MCP error message.",
      "ERROR",
      { message }
    );
  } finally {
    setLoading(false);
    void checkDailyLimit();
  }
}

let chatLoading = false;
let dailyLimitReached = false;

interface DailyLimitStatus {
  limitReached: boolean;
  count: number;
  limit: number;
}

function isDailyLimitStatus(value: unknown): value is DailyLimitStatus {
  return (
    isRecord(value) &&
    typeof value.limitReached === "boolean" &&
    typeof value.count === "number" &&
    typeof value.limit === "number"
  );
}

function applyDailyLimitLockout(status: DailyLimitStatus): void {
  dailyLimitReached = status.limitReached;
  if (!dailyLimitReached) {
    return;
  }
  chatSendButton.disabled = true;
  chatInputElement.disabled = true;
  chatInputElement.placeholder = "";
  chatResponseElement.classList.remove("loading");
  chatResponseElement.classList.add("error");
  chatResponseElement.textContent =
    `Today's demo quota of ${String(status.limit)} requests has been reached. You can try again tomorrow.`;

  // Also disable calculator operator and equals buttons
  buttonElements.forEach((button) => {
    if (button.dataset.tool || button.dataset.action === "equals") {
      button.disabled = true;
    }
  });
}

async function checkDailyLimit(): Promise<void> {
  try {
    const response = await fetch("/daily-limit-status");
    const payload: unknown = await response.json();
    if (response.ok && isDailyLimitStatus(payload)) {
      applyDailyLimitLockout(payload);
    }
  } catch {
    // Silently ignore — limit enforcement still happens server-side.
  }
}

async function sendChatMessage(): Promise<void> {
  const message = chatInputElement.value.trim();
  if (!message || chatLoading || dailyLimitReached) {
    return;
  }

  chatLoading              = true;
  chatSendButton.disabled  = true;
  chatInputElement.disabled = true;
  chatResponseElement.classList.remove("error");
  chatResponseElement.classList.add("loading");
  chatResponseElement.textContent = "Thinking...";

  emitUiTrace(
    "ui_chat_request_sent",
    `UI -> Backend: POST /chat with "${message}".`,
    "Message is sent to backend, which forwards it to OpenAI with MCP tool definitions."
  );

  try {
    const response = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
      body: JSON.stringify({ message })
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Backend returned a non-JSON response.");
    }

    if (response.ok && isChatResponse(payload)) {
      chatResponseElement.classList.remove("loading");
      chatResponseElement.textContent = payload.response;

      emitUiTrace(
        "ui_chat_response_success",
        `Backend -> UI: "${payload.response.slice(0, 80)}${payload.response.length > 80 ? "..." : ""}"`,
        `OpenAI responded after ${String(payload.toolCalls.length)} tool call(s).`,
        "INFO",
        { toolCalls: payload.toolCalls }
      );

      // Sync last successful tool result to calculator display
      const lastSuccess = [...payload.toolCalls].reverse().find(
        (tc) => isRecord(tc.result) && (tc.result as Record<string, unknown>).ok === true
      );
      if (lastSuccess && isRecord(lastSuccess.result)) {
        const result = (lastSuccess.result as Record<string, unknown>).result;
        if (typeof result === "number" && Number.isFinite(result)) {
          state.currentInput          = formatNumber(result);
          state.firstOperand          = null;
          state.pendingTool           = null;
          state.pendingSymbol         = null;
          state.awaitingSecondOperand = false;
          state.expression            = "";
          updateDisplay();
        }
      }

      chatInputElement.value = "";
    } else if (isApiErrorResponse(payload)) {
      throw new Error(payload.details ? `${payload.error} ${payload.details}` : payload.error);
    } else {
      throw new Error("Unexpected response from backend.");
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Chat request failed.";
    chatResponseElement.classList.remove("loading");
    chatResponseElement.classList.add("error");
    chatResponseElement.textContent = errorMessage;
    emitUiTrace(
      "ui_chat_request_failed",
      "Chat request failed.",
      "The error could be from OpenAI, MCP tool execution, or network issues.",
      "ERROR",
      { message: errorMessage }
    );
  } finally {
    chatLoading              = false;
    chatSendButton.disabled  = false;
    chatInputElement.disabled = false;
    chatInputElement.focus();
    void checkDailyLimit();
  }
}

chatSendButton.addEventListener("click", () => {
  void sendChatMessage();
});

chatInputElement.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void sendChatMessage();
  }
});

function bindButtonHandlers(): void {
  /**
   * Centralized click router:
   * - digit
   * - decimal
   * - clear
   * - equals
   * - operator
   */
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

async function loadConsoleHistory(): Promise<void> {
  /**
   * Load prior server traces so user can see startup phases
   * before any new click is made.
   */
  try {
    const response = await fetch("/mcp-events", {
      headers: { "X-Session-Id": sessionId }
    });
    const payload: unknown = await response.json();
    if (!response.ok || !isMcpConsoleEventsResponse(payload)) {
      throw new Error("Unable to load MCP trace history.");
    }
    payload.events.forEach((event) => {
      appendConsoleEvent(event);
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unable to load MCP trace history.";
    emitUiTrace(
      "ui_trace_history_failed",
      "Could not load initial MCP trace history.",
      "The calculator still works, but you may miss startup trace entries until live stream reconnects.",
      "ERROR",
      { message }
    );
  }
}

function connectTraceStream(): void {
  /**
   * Open EventSource stream for live phase-by-phase MCP explanations.
   */
  setStreamState("connecting");
  traceStream = new EventSource(`/mcp-events/stream?sessionId=${encodeURIComponent(sessionId)}`);

  traceStream.addEventListener("open", () => {
    const previousState = streamState;
    setStreamState("connected");
    if (previousState !== "connected") {
      emitUiTrace(
        "ui_trace_stream_connected",
        "Connected to live MCP event stream.",
        "You will now see phase-by-phase protocol activity in real time."
      );
    }
  });

  traceStream.addEventListener("trace", (event: Event) => {
    if (!(event instanceof MessageEvent)) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      emitUiTrace(
        "ui_trace_parse_failed",
        "Received malformed trace message.",
        "The event stream delivered text that was not valid JSON.",
        "ERROR"
      );
      return;
    }

    if (!isMcpConsoleEvent(payload)) {
      emitUiTrace(
        "ui_trace_invalid_shape",
        "Trace message had unexpected shape.",
        "Type guards rejected the payload to keep UI rendering safe.",
        "ERROR"
      );
      return;
    }

    appendConsoleEvent(payload);
  });

  /* Server sends a "clear" event at the start of every new execution. */
  traceStream.addEventListener("clear", () => {
    consoleListElement.replaceChildren();
    seenTraceIds = new Set();
  });

  traceStream.addEventListener("error", () => {
    if (streamState !== "disconnected") {
      setStreamState("disconnected");
      emitUiTrace(
        "ui_trace_stream_disconnected",
        "Live trace stream disconnected.",
        "EventSource will retry automatically; once connected, updates resume.",
        "ERROR"
      );
    }
  });
}

async function initializeTools(): Promise<void> {
  /**
   * Dynamic capability discovery:
   * UI enables/disables operator buttons based on backend listTools() cache.
   */
  try {
    emitUiTrace(
      "ui_tool_discovery_started",
      "UI is requesting available calculator tools.",
      "The UI asks backend for discovered tools instead of hardcoding capabilities."
    );

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

    emitUiTrace(
      "ui_tool_discovery_complete",
      `UI discovered ${String(payload.tools.length)} tool(s): ${payload.tools.map((tool) => tool.name).join(", ")}.`,
      "Buttons remain enabled only for tools currently advertised by backend discovery.",
      "INFO",
      { tools: payload.tools.map((tool) => tool.name) }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to load calculator tools.";
    setStatus(message, true);
    emitUiTrace(
      "ui_tool_discovery_failed",
      "Tool discovery failed.",
      "Without discovery the UI cannot guarantee backend tool availability.",
      "ERROR",
      { message }
    );
  }
}

bindButtonHandlers();
clearAll();

consoleClearButton.addEventListener("click", () => {
  consoleListElement.replaceChildren();
  emitUiTrace(
    "ui_console_cleared",
    "Learning console cleared.",
    "Incoming live events continue streaming; older entries were removed only from this browser view."
  );
});

emitUiTrace(
  "ui_boot",
  "Calculator UI booted.",
  "Next steps: fetch discovered tools, connect to live MCP trace stream, and wait for user actions."
);

void loadConsoleHistory();
connectTraceStream();
void initializeTools();
void checkDailyLimit();

window.addEventListener("beforeunload", () => {
  traceStream?.close();
});
