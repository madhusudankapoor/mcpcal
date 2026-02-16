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
- OpenAI chooses tools, backend executes tools
- typed validation and errors across UI -> backend -> MCP

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
- OpenAI: LLM request, tool selection, response

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
5. `buildOpenAiFunctions()` converts them to OpenAI format for the chat endpoint.

### Phase 3: Tool Execution

For `5 + 3 =` (button click):
1. UI POSTs `/calculate` with `{ tool: "add", args: { a: 5, b: 3 } }`.
2. Backend validates payload with Zod.
3. Backend calls `client.callTool(...)`.
4. MCP server validates args with Zod, computes result, returns payload.
5. Backend formats `{ result, expression }`.
6. UI displays `8`.

For "what is 5 plus 3?" (chat):
1. UI POSTs `/chat` with `{ message: "what is 5 plus 3?" }`.
2. Backend validates with `ChatRequestSchema` (Zod).
3. Backend sends message + tool definitions to OpenAI.
4. OpenAI returns `tool_calls` selecting `add` with `{ a: 5, b: 3 }`.
5. Backend validates args with Zod, executes via `mcpClient.callTool(...)`.
6. Tool results are sent back to OpenAI for a natural language answer.
7. UI displays the LLM response and syncs the calculator display.

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
5. Type "what is 10 times 5?" in the chat input, hit Send.
6. Chat response shows LLM answer, calculator display updates to 50.
7. MCP Learning Console shows new trace events: `llm_request`, `llm_tool_selection`, `llm_response`.
8. Non-math messages like "hello" get a polite redirect response without tool calls.

## Why MCP for a Calculator?

For production math, MCP is unnecessary. This project is educational and intentionally overkill.

Real MCP value appears when:
- tools are remote and heterogeneous
- LLM agents need standardized tool discovery/calling
- you need protocol-level interoperability across clients/servers

The OpenAI chat integration demonstrates how LLMs use MCP tools in the standard agentic flow: the LLM decides which tools to call, and the MCP client executes them.

## GitHub Readiness Checklist

- Strict TypeScript enabled
- Runtime validation with Zod on all boundaries
- Structured logs at all layers
- OpenAI LLM integration with function calling
- Clear folder structure and scripts
- Documented architecture and flow
- `.env` excluded from version control via `.gitignore`
