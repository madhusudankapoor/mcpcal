# MCP Calculator (TypeScript)

A beginner-friendly project to learn **Model Context Protocol (MCP)** with real code.

This app supports two user paths using the same MCP tools:

1. Button calculator (`/calculate`)
2. Natural language chat (`/chat`) with OpenAI function calling

## Quick Start

1. Open terminal in your project root (folder name can be anything): `.../mcp-calculator`
2. Install + build:
   ```bash
   npm install
   npm run build
   ```
3. Add OpenAI key (for chat):
   ```bash
   echo 'OPENAI_API_KEY=sk-...' > .env
   ```
4. Start backend (it auto-starts MCP server):
   ```bash
   npm run start:client
   ```
5. Open [http://localhost:3000](http://localhost:3000), try `5 + 3 =`, OR just ask in the chat: `what is 12 times 7?`

What you learn in this demo:
- MCP handshake + tool discovery (`listTools`)
- MCP remote execution (`callTool`)
- **Agentic Loop** — multi-round observe→think→act cycle
- **Chain of Thought** — LLM reasoning before tool calls
- **Tool Calling** — LLM selects tools, backend executes via MCP
- **Prompt Engineering** — system prompt design for tool-using agents
- Typed validation and errors across UI → backend → MCP

## Core MCP Concepts In This Project

This codebase demonstrates the most important MCP ideas:

1. **MCP server** exposes tools (`add`, `subtract`, `multiply`, `divide`).
2. **MCP client** (Express backend) connects over stdio.
3. **Handshake** completes before serving requests.
4. **Tool discovery** happens with `listTools()` on startup.
5. **Tool execution** happens with `callTool(name, args)`.
6. **Stateless server design**: UI stores interaction state, MCP server does pure compute.
7. **Runtime validation** with Zod for HTTP, tool args, and response parsing.
8. **Typed error propagation** from MCP server -> backend -> UI.

## Project Components

1. **MCP Server** (`src/server/calculator-server.ts`)
2. **Express Backend + MCP Client + OpenAI Orchestrator** (`src/client/client-backend.ts`)
3. **Web UI (calculator + chat + learning console)** (`src/client/ui/app.ts`)
4. **Shared contracts and schemas** (`src/shared/types.ts`)

## MCP Lifecycle (How Requests Work)

### Phase 1: Startup / Handshake

1. Backend starts.
2. Backend opens `StdioClientTransport`.
3. MCP server process is spawned.
4. `mcpClient.connect(...)` performs handshake and capability negotiation.


## Project Structure

```text
mcp-calculator/
├── src/
│   ├── server/
│   │   └── calculator-server.ts    # MCP server (tools live here)
│   ├── client/
│   │   ├── client-backend.ts       # Express backend + MCP client + OpenAI orchestrator
│   │   └── ui/
│   │       └── app.ts              # Browser-side UI logic
│   └── shared/
│       └── types.ts                # Shared types, Zod schemas
├── public/
│   ├── index.html                  # Calculator + chat panel HTML
│   ├── app.js                      # Compiled UI (generated)
│   └── styles.css
├── package.json
├── tsconfig.json
├── tsconfig.server.json
├── tsconfig.client.json
└── README.md
```

## Prerequisites

- Node.js >= 20
- An OpenAI API key (for the chat feature)

## Setup

```bash
npm install
npm run build
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes (for chat) | — | Your OpenAI API key. The chat feature will not work without it. |
| `PORT` | No | `3000` | HTTP server port. |
| `MCP_SERVER_ENTRY` | No | Auto-detected | Path to the MCP server entry file. |

### Setting the OpenAI API key

Create a `.env` file in the project root (it is already in `.gitignore`):

```bash
echo 'OPENAI_API_KEY=sk-...' > .env
```

The app uses `dotenv` and automatically loads variables from `.env` at startup.

## Running the App

```bash
npm run dev
```

This builds TypeScript and starts the client backend, which automatically spawns the MCP server process over stdio. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Features

### Calculator (button UI)

Click digit and operator buttons to perform calculations. Each operation goes through the full MCP flow: `UI -> Express Backend -> MCP Client -> MCP Server -> tool execution`.

### Chat (LLM-powered)

Type a natural language math question (e.g., "what is 42 times 17?") in the chat input below the calculator buttons. The message is sent to OpenAI, which uses function calling to select MCP tools. The backend executes them via `mcpClient.callTool()`, and OpenAI generates a natural language answer.

- Math questions trigger MCP tool calls automatically.
- Non-math messages get a polite redirect without tool calls.
- The calculator display syncs with the last successful tool result.

### MCP Learning Console

A live, user-facing console below the chat panel explains MCP flow in plain language. Events stream from the backend using Server-Sent Events.

- Phase 1: handshake
- Phase 2: tool discovery
- Phase 3: tool execution
- **Agentic Loop data flow** (for chat):
  - `llm_sending_messages` — human-readable snapshot of what's being sent to the LLM
  - `llm_received_response` — what the LLM returned (tool calls, text, or both)
  - `llm_chain_of_thought` — LLM's reasoning when it "thinks out loud"
  - `llm_tool_selection` — which tools selected with exact arguments
  - `llm_tool_results_feeding_back` — computed results being fed back to the LLM
  - `llm_response` — final answer with natural vs safety termination explanation

Endpoints:
- `GET /mcp-events` — history snapshot
- `GET /mcp-events/stream` — live SSE updates

---

## How Does OpenAI Talk to the MCP Server?

**Short answer: it doesn't. OpenAI never talks to your MCP server directly.**

This is the most important concept to understand. OpenAI's role is to **decide** which tools to call. Your backend **executes** those tools via MCP. Here's why:

```text
  Common misconception:

    User  -->  OpenAI  -->  MCP Server  -->  result      WRONG!

  What actually happens:

    User  -->  Backend  -->  OpenAI  (just decides)
                         <--  "call add(15, 27)"
              Backend  -->  MCP Server  (actually executes)
                         <--  { result: 42 }
              Backend  -->  OpenAI  (explain the result)
                         <--  "15 plus 27 equals 42"
              Backend  -->  User
```

OpenAI is like a **brain that can't move its hands**. It can look at a menu of tools and say "I want to use the add tool with these numbers", but it cannot actually run the tool. Your backend is the one that takes that instruction, calls the MCP server, gets the result, and feeds it back to OpenAI so it can write a human-friendly answer.

## Architecture Overview

```text
┌─────────────────────────────────────────────────────────────────┐
│                        YOUR MACHINE                             │
│                                                                 │
│  ┌─────────────┐     HTTP      ┌───────────────────────────┐    │
│  │  Browser UI │ ────────────> │  Express Backend          │    │
│  │             │               │  (client-backend.ts)      │    │
│  │ Calculator  │  POST /chat   │                           │    │
│  │ buttons     │ ────────────> │  1. Receives user message │    │
│  │             │               │  2. Talks to OpenAI       │    │
│  │ Chat input  │               │  3. Executes MCP tools    │    │
│  │             │  JSON response│  4. Talks to OpenAI again │    │
│  │ Chat output │ <──────────── │  5. Returns final answer  │    │
│  └─────────────┘               └──────┬──────────┬─────────┘    │
│                                       │          │              │
│                                MCP/stdio    HTTPS API           │
│                                       │          │              │
│                                       ▼          │              │
│                              ┌──────────────┐    │              │
│                              │  MCP Server  │    │              │
│                              │  (separate   │    │              │
│                              │   process)   │    │              │
│                              │              │    │              │
│                              │  Tools:      │    │              │
│                              │  - add       │    │              │
│                              │  - subtract  │    │              │
│                              │  - multiply  │    │              │
│                              │  - divide    │    │              │
│                              └──────────────┘    │              │
│                                                  │              │
└──────────────────────────────────────────────────┼──────────────┘
                                                   │
                                                   ▼
                                          ┌───────────────┐
                                          │  OpenAI API   │
                                          │  (cloud)      │
                                          │               │
                                          │  gpt-4o-mini  │
                                          │               │
                                          │  Receives:    │
                                          │  - message    │
                                          │  - tool menu  │
                                          │               │
                                          │  Returns:     │
                                          │  - which tool │
                                          │    to call    │
                                          │  - or a text  │
                                          │    response   │
                                          └───────────────┘
```

**Key insight:** The backend is the **orchestrator**. It sits in the middle and coordinates between three things:
1. The browser (receives user input, sends back answers)
2. OpenAI (sends tool menus, receives tool decisions)
3. MCP Server (sends tool calls, receives computed results)

## Chat Data Flow: Step by Step

Here is exactly what happens when you type "What is 15 plus 27?" and hit Send:

```text
Step 1: User sends message
═══════════════════════════

  Browser                    Backend
    │                          │
    │  POST /chat              │
    │  { message: "What is     │
    │    15 plus 27?" }        │
    │ ──────────────────────>  │
    │                          │


Step 2: Backend tells OpenAI about available tools
══════════════════════════════════════════════════

  Backend                                    OpenAI API
    │                                          │
    │  "Here is a user question,               │
    │   and here are the tools you can use:    │
    │                                          │
    │   - add(a, b): Add two numbers           │
    │   - subtract(a, b): Subtract             │
    │   - multiply(a, b): Multiply             │
    │   - divide(a, b): Divide                 │
    │                                          │
    │   User asks: What is 15 plus 27?"        │
    │ ─────────────────────────────────────>   │
    │                                          │
    │          (OpenAI thinks...)              │
    │          "15 plus 27 = addition!"        │
    │          "I'll pick the add tool"        │
    │                                          │
    │  tool_calls: [{                          │
    │    name: "add",                          │
    │    arguments: { a: 15, b: 27 }           │
    │  }]                                      │
    │ <──────────────────────────────────────  │
    │                                          │

  NOTE: OpenAI does NOT execute "add".
  It just says "I WANT to call add(15, 27)".
  The backend must do the actual work.


Step 3: Backend executes the tool via MCP
═════════════════════════════════════════

  Backend                         MCP Server
    │                               │
    │  callTool("add", {a:15,b:27}) │
    │ ───────────────────────────>  │
    │                               │
    │          (server computes     │
    │           15 + 27 = 42)       │
    │                               │
    │  { ok: true, result: 42 }     │
    │ <───────────────────────────  │
    │                               │


Step 4: Backend sends result back to OpenAI
═══════════════════════════════════════════

  Backend                                    OpenAI API
    │                                          │
    │  "The add tool returned: 42.             │
    │   Now give the user a friendly answer."  │
    │ ──────────────────────────────────────>  │
    │                                          │
    │  "15 plus 27 equals 42."                 │
    │ <──────────────────────────────────────  │
    │                                          │


Step 5: Backend returns the final answer to the browser
═══════════════════════════════════════════════════════

  Browser                    Backend
    │                          │
    │  {                       │
    │    response: "15 plus    │
    │      27 equals 42.",     │
    │    toolCalls: [{         │
    │      tool: "add",        │
    │      args: {a:15, b:27}, │
    │      result: {ok:true,   │
    │        result:42}        │
    │    }]                    │
    │  }                       │
    │ <──────────────────────  │
    │                          │
    │  UI shows: "15 plus 27   │
    │  equals 42."             │
    │  Display updates to: 42  │
```

## How the Tool Menu Gets Built

A key part of MCP is **tool discovery**. The backend doesn't hardcode what tools exist. Instead:

```text
At startup:

  Backend                          MCP Server
    │                                │
    │  "What tools do you have?"     │
    │  (listTools)                   │
    │ ────────────────────────────>  │
    │                                │
    │  "I have 4 tools:              │
    │   add, subtract, multiply,     │
    │   divide. Here are their       │
    │   descriptions and argument    │
    │   schemas."                    │
    │ <────────────────────────────  │
    │                                │
    │  Backend caches these tools.   │
    │  Converts them to OpenAI       │
    │  function-calling format.      │

Later, when chat is used:

  Backend takes the cached MCP tool definitions
  and sends them to OpenAI as a "tool menu":

    MCP format:                    OpenAI format:
    {                              {
      name: "add",        -->        type: "function",
      description: "Add             function: {
        two numbers",                  name: "add",
      inputSchema: {                   description: "Add two numbers",
        properties: {                  parameters: {
          a: {type:"number"},            properties: {
          b: {type:"number"}               a: {type:"number"},
        }                                  b: {type:"number"}
      }                                  }
    }                                  }
                                     }

  This means if the MCP server adds a new tool tomorrow,
  the LLM automatically gets access to it. No code changes needed.
```

## Agentic Loop, Chain of Thought, and Tool Calling

The `/chat` endpoint implements a full **agentic loop** — the core AI pattern that turns a single LLM call into an autonomous agent. Instead of one request/response, the backend loops through multiple rounds of observe → think → act until the LLM has enough information to answer.

### What is an Agentic Loop?

```text
┌─────────────────────────────────────────────────────────┐
│                     AGENTIC LOOP                        │
│                                                         │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│  │ OBSERVE  │───▶│  THINK   │───▶│   ACT    │          │
│  │ (see     │    │ (LLM     │    │ (execute │          │
│  │ results) │    │ reasons) │    │ tools)   │          │
│  └──────────┘    └──────────┘    └──────────┘          │
│       ▲                               │                 │
│       └───────────────────────────────┘                 │
│              loop until done                            │
└─────────────────────────────────────────────────────────┘
```

A **single LLM call** can only use information already in the prompt. The agentic loop lets the LLM *gather new information* (via tools) across multiple rounds, building up context until it can produce a final answer. This is what makes it an "agent" rather than a simple chatbot.

### Multi-Round Example: "What is 4 * 4 * 4?"

This question requires **two rounds** because the LLM must multiply step-by-step:

```text
ROUND 1:
  → SENDING TO LLM:
    [SYSTEM] You are a calculator assistant. Use the provided tools...
    [USER] "what is 4 * 4 * 4?"

  ← LLM RETURNED:
    LLM wants to call 1 tool(s):
      → multiply(a=4, b=4)

  ↻ FEEDING BACK tool results:
    multiply(4, 4) = 16

ROUND 2:
  → SENDING TO LLM:
    [SYSTEM] You are a calculator assistant...
    [USER] "what is 4 * 4 * 4?"
    [ASSISTANT] → tool calls: multiply({"a":4,"b":4})
    [TOOL RESULT] {"ok":true,"result":16}

  ← LLM RETURNED:
    LLM wants to call 1 tool(s):
      → multiply(a=16, b=4)

  ↻ FEEDING BACK tool results:
    multiply(16, 4) = 64

ROUND 3:
  → SENDING TO LLM:
    [SYSTEM] You are a calculator assistant...
    [USER] "what is 4 * 4 * 4?"
    [ASSISTANT] → tool calls: multiply({"a":4,"b":4})
    [TOOL RESULT] {"ok":true,"result":16}
    [ASSISTANT] → tool calls: multiply({"a":16,"b":4})
    [TOOL RESULT] {"ok":true,"result":64}

  ← LLM RETURNED:
    LLM final answer: "4 * 4 * 4 equals 64."

  ✓ Agentic loop complete — natural termination after 3 rounds.
```

Notice how the conversation **grows each round**. The LLM sees ALL previous tool calls and results, which is how it knows to multiply 16 × 4 (not 4 × 4 again).

### Chain of Thought (CoT)

Sometimes the LLM includes **text content alongside tool calls** — it "thinks out loud" about which tools to use and why before acting. This is called **Chain of Thought** reasoning.

For example, when asked "what is (2 + 3) times (4 + 5)?", the LLM might respond:

```text
← LLM RETURNED:
  LLM is thinking: "I need to compute 2+3 and 4+5 first, then multiply the results."
  LLM wants to call 2 tool(s):
    → add(a=2, b=3)
    → add(a=4, b=5)
```

The thinking text is logged as a `llm_chain_of_thought` event in the MCP Learning Console so you can see the LLM's reasoning process.

### How the Loop Terminates

The agentic loop ends in one of two ways:

1. **Natural termination:** The LLM returns a message with **no tool calls**, meaning it has enough information to answer. This is the normal case.

2. **Safety termination:** The loop hits the `maxRounds` limit (default: 10) to prevent infinite loops. This is a safety net in case the LLM keeps calling tools without converging.

### Educational Helper Functions in client-backend.ts

The `/chat` route is a thin **5-step orchestrator** that delegates AI logic to educational helper functions. Reading them in order teaches you the key concepts:

| Step | Function | AI Concept |
|------|----------|------------|
| 1 | Request validation (Zod) | Runtime type safety |
| 2 | `buildConversation(message)` | **Prompt Engineering** — system prompt + user message |
| 3 | `convertMcpToolsToOpenAiFormat()` | **Tool Calling** — MCP↔OpenAI schema bridging |
| 4 | `runAgenticLoop(messages, tools, mcpClient, 10)` | **Agentic Loop** — observe→think→act cycle |
| 5 | Return response | HTTP response formatting |

Inside the agentic loop, two more helpers handle tool execution:

| Helper | AI Concept |
|--------|------------|
| `executeSingleToolCall(toolCall, mcp)` | **Tool Execution Pipeline** — parse→validate→execute→parse result |
| `executeToolCallsFromLlm(functionCalls, mcp)` | **Parallel Tool Calling** — batch execution of multiple tool calls |

### MCP Learning Console: What You'll See

The learning console now shows **detailed data flow** at each agentic round:

| Event | Arrow | What It Shows |
|-------|-------|---------------|
| `llm_sending_messages` | → | Full conversation being sent to the LLM |
| `llm_received_response` | ← | What the LLM returned (text, tool calls, or both) |
| `llm_chain_of_thought` | 💭 | LLM's reasoning text when it "thinks out loud" |
| `llm_tool_selection` | 🔧 | Which tools the LLM chose with exact arguments |
| `llm_tool_results_feeding_back` | ↻ | Tool results being added to conversation for next round |
| `llm_response` | ✓ | Final answer + how the loop terminated |

These traces show the **actual data** flowing between your backend and OpenAI, so you can see exactly how the agentic loop works in practice.

## Calculator (Button) Data Flow

For comparison, here is the simpler button-click flow that does NOT involve OpenAI:

```text
User clicks  5  +  3  =

  Browser                    Backend                    MCP Server
    │                          │                          │
    │ POST /calculate          │                          │
    │ {tool:"add",             │                          │
    │  args:{a:5, b:3}}        │                          │
    │ ──────────────────────>  │                          │
    │                          │ callTool("add",{a:5,b:3})│
    │                          │ ──────────────────────>  │
    │                          │                          │
    │                          │ {ok:true, result:8}      │
    │                          │ <──────────────────────  │
    │                          │                          │
    │ {result:8,               │                          │
    │  expression:"5 + 3"}     │                          │
    │ <──────────────────────  │                          │
    │                          │                          │
    │ Display: 8               │                          │

  No OpenAI involved. The UI already knows which tool to call
  because the user clicked the "+" button (= "add" tool).
```

## Two Paths, Same MCP Server

```text
                    ┌─────────────────────────┐
  Button click:     │                         │
  User picks tool   │      MCP Server         │
  ─────────────────>│      (same server,      │
                    │       same tools,       │
  Chat message:     │       same result)      │
  LLM picks tool    │                         │
  ─────────────────>│                         │
                    └─────────────────────────┘

  The MCP server doesn't know or care WHO decided to call it.
  It just receives callTool() and returns a result.
```

---

## MCP Protocol Flow Implemented

### Phase 1: Initialization

1. Client backend starts.
2. Backend creates `StdioClientTransport`.
3. MCP SDK spawns calculator server process.
4. Backend calls `client.connect(...)`.
5. MCP handshake and capability negotiation complete.

### Phase 2: Tool Discovery

1. Backend calls `client.listTools()`.
2. MCP server returns tool definitions (`add`, `subtract`, `multiply`, `divide`).
3. Backend normalizes and caches the list.
4. `/tools` endpoint exposes discovered tools for the UI buttons.
5. `convertMcpToolsToOpenAiFormat()` converts them to OpenAI format for the chat endpoint.

### Phase 3: Tool Execution

For `5 + 3 =` (button click):
1. UI POSTs `/calculate` with `{ tool: "add", args: { a: 5, b: 3 } }`.
2. Backend validates payload with Zod.
3. Backend calls `client.callTool(...)`.
4. MCP server validates args with Zod, computes result, returns payload.
5. Backend formats `{ result, expression }`.
6. UI displays `8`.

For "what is 5 plus 3?" (chat) — single-round agentic loop:
1. UI POSTs `/chat` with `{ message: "what is 5 plus 3?" }`.
2. Backend validates with `ChatRequestSchema` (Zod).
3. `buildConversation()` creates system prompt + user message.
4. `convertMcpToolsToOpenAiFormat()` translates MCP tools to OpenAI format.
5. `runAgenticLoop()` starts — Round 1: sends conversation + tools to OpenAI.
6. OpenAI returns `tool_calls` selecting `add` with `{ a: 5, b: 3 }`.
7. `executeToolCallsFromLlm()` validates args with Zod, executes via MCP `callTool()`.
8. Tool results are fed back into conversation — Round 2: LLM sees results, returns final text.
9. Agentic loop terminates naturally. UI displays the LLM response and syncs the calculator display.

For "what is 4 * 4 * 4?" (chat) — multi-round agentic loop:
1. Same steps 1–5 as above.
6. Round 1: OpenAI calls `multiply(4, 4)` → result 16 fed back.
7. Round 2: OpenAI calls `multiply(16, 4)` → result 64 fed back.
8. Round 3: OpenAI returns final answer "4 * 4 * 4 equals 64." — natural termination.
9. UI displays the LLM response. MCP console shows all 3 rounds with data flow.

## API Endpoints

### `GET /tools`

Returns discovered tools:

```json
{
  "tools": [
    {
      "name": "add",
      "description": "Add two numbers together",
      "inputSchema": {
        "type": "object",
        "properties": {
          "a": { "type": "number", "description": "First number" },
          "b": { "type": "number", "description": "Second number" }
        },
        "required": ["a", "b"],
        "additionalProperties": false
      }
    }
  ]
}
```

### `POST /calculate`

Request:

```json
{
  "tool": "divide",
  "args": { "a": 5, "b": 2 }
}
```

Success response:

```json
{
  "result": 2.5,
  "expression": "5 / 2"
}
```

Error response:

```json
{
  "error": "Division by zero is not allowed.",
  "details": "Provide a non-zero divisor."
}
```

### `POST /chat`

Request:

```json
{
  "message": "what is 10 times 5?"
}
```

Success response:

```json
{
  "response": "10 times 5 equals 50.",
  "toolCalls": [
    {
      "tool": "multiply",
      "args": { "a": 10, "b": 5 },
      "result": { "ok": true, "result": 50 }
    }
  ]
}
```

Error response (no API key):

```json
{
  "error": "Internal server error.",
  "details": "The OPENAI_API_KEY environment variable is missing."
}
```

### `GET /mcp-events`

Returns trace history snapshot for the learning console.

### `GET /mcp-events/stream`

Live Server-Sent Events stream of trace events.

## Why Zod if TypeScript Exists?

TypeScript types are erased at runtime. Network/process boundaries still receive `unknown` data.

Zod gives runtime guarantees at:
- HTTP boundary (UI -> backend)
- MCP boundary (backend -> MCP server)
- Chat boundary (LLM function call arguments -> tool execution)

This prevents invalid payloads from becoming hidden runtime bugs.

## Stateless MCP Server Design

Calculator state (first number, selected operation, second number) is managed entirely in the UI.

The MCP server remains stateless by design:
- easier to scale
- safer for concurrent calls
- cleaner RPC mental model

The chat endpoint is also single-turn (no conversation history), keeping the same stateless philosophy.


## Verification Checklist

1. `npm run build` compiles without errors.
2. `npm run dev` starts the server on port 3000 (with `.env` or `OPENAI_API_KEY` set).
3. Open http://localhost:3000.
4. Calculator buttons work as before (existing MCP flow unchanged).
5. Type "what is 5 + 3?" in the chat input, hit Send — single-round agentic loop.
6. Chat response shows LLM answer, calculator display updates to 8.
7. Type "what is 4 * 4 * 4?" — multi-round agentic loop (2+ tool rounds).
8. MCP Learning Console shows detailed data flow at each round:
   - `llm_sending_messages` — what's being sent to the LLM
   - `llm_received_response` — what the LLM returned
   - `llm_tool_selection` — which tools with exact arguments
   - `llm_tool_results_feeding_back` — tool results going back to LLM
   - `llm_response` — final answer with termination type
9. Non-math messages like "hello" get a polite redirect response without tool calls.

## Why MCP for a Calculator?

For production math, MCP is unnecessary. This project is educational and intentionally overkill.

Real MCP value appears when:
- tools are remote and heterogeneous
- LLM agents need standardized tool discovery/calling
- you need protocol-level interoperability across clients/servers

The OpenAI chat integration demonstrates the full agentic flow: prompt engineering, tool calling, chain-of-thought reasoning, and the multi-round agentic loop — all with detailed human-readable logging so you can see exactly what data flows between your backend and the LLM at each step.

## GitHub Readiness Checklist

- Strict TypeScript enabled
- Runtime validation with Zod on all boundaries
- Structured logs at all layers
- OpenAI LLM integration with function calling
- Clear folder structure and scripts
- Documented architecture and flow
- `.env` excluded from version control via `.gitignore`
