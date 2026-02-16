# MCP Calculator (TypeScript)

> **[Live Demo](https://mcp-demo-ixpr.onrender.com/)** — try it without installing anything

## Why This Exists

Most AI tutorials explain concepts with slides or pseudocode. This project takes a different approach: **you learn by reading a working app**.

The domain is deliberately simple (a calculator) so you can focus entirely on the AI patterns. Every function is named after the concept it teaches. The code reads top to bottom like a textbook.

I built this because when I started building AI applications, I wanted one small codebase that showed how all the pieces fit together — MCP, tool calling, agentic loops, chain of thought, prompt engineering — wired up end to end with real HTTP requests, real LLM calls, and real tool execution. This is that codebase.

## What You Will Learn

Five AI engineering concepts, all visible in the code:

| # | Concept | Where in the code |
|---|---------|-------------------|
| 1 | **MCP (Model Context Protocol)** — how an LLM discovers and calls external tools | `calculator-server.ts`, `initializeMcp()` |
| 2 | **Tool Calling** — the LLM picks a function and arguments, your code runs it | `convertMcpToolsToOpenAiFormat()`, `executeSingleToolCall()` |
| 3 | **Agentic Loop** — the LLM runs in a loop: think, act, observe, repeat | `runAgenticLoop()` |
| 4 | **Chain of Thought** — the LLM "thinks out loud" before choosing tools | Inside `runAgenticLoop()`, look for `llm_chain_of_thought` |
| 5 | **Prompt Engineering** — how a system prompt shapes LLM behavior | `buildConversation()` |

## Who This Is For

- **Engineers learning MCP** — see handshake, discovery, and tool execution working end to end
- **People building their first AI agent** — the agentic loop here is the same pattern used by production agents, just smaller
- **Anyone curious about tool calling** — watch the LLM decide which function to call and with what arguments
- **TypeScript developers** — strict types, Zod validation at every boundary, clean project structure

No AI experience needed. If you can read TypeScript and understand HTTP requests, you can follow this code.

## 5-Minute Quickstart

**Prerequisites:** Node.js >= 20, an OpenAI API key

```bash
# 1. Clone
git clone https://github.com/madhusudankapoor/mcpcal.git
cd mcpcal

# 2. Install and build
npm install
npm run build

# 3. Add your OpenAI key
echo 'OPENAI_API_KEY=sk-...' > .env

# 4. Start (backend auto-spawns MCP server)
npm run start:client
```

Open [http://localhost:3000](http://localhost:3000).

**Try these three things:**

1. Click `5 + 3 =` — watch the learning console show MCP phases (handshake → discovery → execution)
2. Type `what is 5 + 3?` in chat — single-round agentic loop (LLM calls one tool, gets answer)
3. Type `what is 4 * 4 * 4?` in chat — multi-round agentic loop (LLM calls multiply twice across 3 rounds)

The learning console at the bottom shows every step: what gets sent to the LLM, what comes back, which tools are selected, and how the loop converges on an answer.

Or skip setup entirely and use the **[Live Demo](https://mcp-demo-ixpr.onrender.com/)**.

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                        YOUR MACHINE                             │
│                                                                 │
│  ┌─────────────┐     HTTP      ┌───────────────────────────┐   │
│  │  Browser UI  │ ────────────> │  Express Backend          │   │
│  │              │               │  (client-backend.ts)      │   │
│  │ Calculator   │  POST /chat   │                           │   │
│  │ buttons      │ ────────────> │  1. Receives user message │   │
│  │              │               │  2. Talks to OpenAI       │   │
│  │ Chat input   │               │  3. Executes MCP tools    │   │
│  │              │  JSON response│  4. Talks to OpenAI again │   │
│  │ Chat output  │ <──────────── │  5. Returns final answer  │   │
│  └──────────────┘               └──────┬──────────┬─────────┘   │
│                                        │          │             │
│                                 MCP/stdio    HTTPS API          │
│                                        │          │             │
│                                        ▼          │             │
│                               ┌──────────────┐   │             │
│                               │  MCP Server   │   │             │
│                               │  (separate    │   │             │
│                               │   process)    │   │             │
│                               │               │   │             │
│                               │  Tools:       │   │             │
│                               │  - add        │   │             │
│                               │  - subtract   │   │             │
│                               │  - multiply   │   │             │
│                               │  - divide     │   │             │
│                               └───────────────┘   │             │
│                                                   │             │
└───────────────────────────────────────────────────┼─────────────┘
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

**The key idea:** OpenAI never talks to your MCP server. OpenAI is a brain that cannot move its hands. It looks at a menu of tools and says "I want to call add(15, 27)". Your backend actually runs the tool via MCP and feeds the result back.

## How It Works: Step by Step

### What Happens When You Type "What is 15 plus 27?"

```text
Step 1: Browser sends message to backend
        POST /chat { message: "What is 15 plus 27?" }

Step 2: Backend sends message + tool menu to OpenAI
        "Here is a user question. Here are tools you can use:
         add(a,b), subtract(a,b), multiply(a,b), divide(a,b)"

Step 3: OpenAI decides (does NOT execute)
        "I want to call add(a=15, b=27)"

Step 4: Backend executes via MCP
        callTool("add", {a:15, b:27}) → { ok: true, result: 42 }

Step 5: Backend feeds result back to OpenAI
        "The add tool returned 42. Give the user a friendly answer."

Step 6: OpenAI responds
        "15 plus 27 equals 42."

Step 7: Backend returns answer to browser
```

### The Agentic Loop

Simple questions finish in one round. But "what is 4 * 4 * 4?" needs multiple rounds because the LLM can only multiply two numbers at a time:

```text
┌─────────────────────────────────────────────────────┐
│                   AGENTIC LOOP                      │
│                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐      │
│  │ OBSERVE  │───▶│  THINK   │───▶│   ACT    │      │
│  │ (tool    │    │ (LLM     │    │ (execute │      │
│  │ results) │    │ reasons) │    │ tools)   │      │
│  └──────────┘    └──────────┘    └──────────┘      │
│       ▲                               │             │
│       └───────────────────────────────┘             │
│              loop until done                        │
└─────────────────────────────────────────────────────┘

Round 1: User asks "what is 4 * 4 * 4?"
         LLM thinks → calls multiply(4, 4)
         Tool returns 16

Round 2: LLM sees 16
         LLM thinks → calls multiply(16, 4)
         Tool returns 64

Round 3: LLM sees 64
         No more tools needed → returns "4 * 4 * 4 equals 64."
```

The conversation grows each round. The LLM sees ALL previous tool calls and results, which is how it knows to multiply 16 x 4 instead of 4 x 4 again.

The loop ends in one of two ways:
- **Natural:** The LLM returns text with no tool calls — it has its answer.
- **Safety:** The loop hits the max rounds limit (10) to prevent infinite loops.

### Chain of Thought

Sometimes the LLM thinks out loud before calling tools. For example, when asked "what is (2 + 3) times (4 + 5)?":

```text
LLM is thinking: "I need to compute 2+3 and 4+5 first, then multiply."
LLM wants to call 2 tool(s):
  → add(a=2, b=3)
  → add(a=4, b=5)
```

This reasoning text is logged as a Chain of Thought event in the learning console.

### Two Paths, Same MCP Server

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
```

## MCP Lifecycle

### Phase 1: Startup Handshake

At startup, the backend spawns the MCP server as a child process and connects over stdio:

```text
Backend                          MCP Server
  │  spawn process + connect       │
  │ ────────────────────────────>  │
  │  handshake + capabilities      │
  │ <────────────────────────────  │
```

### Phase 2: Tool Discovery

Backend asks the MCP server what tools it has. This list is cached and used for both the button UI and the OpenAI tool menu:

```text
Backend                          MCP Server
  │  listTools()                   │
  │ ────────────────────────────>  │
  │  [add, subtract, multiply,     │
  │   divide] with JSON Schemas    │
  │ <────────────────────────────  │
```

The MCP tool format gets translated to OpenAI format so the LLM understands it:

```text
MCP format:                    OpenAI format:
{                              {
  name: "add",        -->        type: "function",
  description: "Add             function: {
    two numbers",                  name: "add",
  inputSchema: {                   description: "Add two numbers",
    properties: {                  parameters: {
      a: {type:"number"},            properties: {
      b: {type:"number"}               a: {type:"number"},
    }                                   b: {type:"number"}
  }                                   }
}                                   }
                                 }
```

If the MCP server adds a new tool tomorrow, the LLM gets access to it automatically. No code changes needed.

### Phase 3: Tool Execution

For button clicks:

```text
Browser                    Backend                    MCP Server
  │ POST /calculate          │                          │
  │ {tool:"add",             │                          │
  │  args:{a:5, b:3}}        │                          │
  │ ──────────────────────>  │ callTool("add",{a:5,b:3})│
  │                          │ ──────────────────────>  │
  │                          │ {ok:true, result:8}      │
  │                          │ <──────────────────────  │
  │ {result:8,               │                          │
  │  expression:"5 + 3"}     │                          │
  │ <──────────────────────  │                          │
```

For chat, the same `callTool()` happens inside the agentic loop. The MCP server does not know or care who called it.

## The /chat Endpoint — 5 Steps

The chat route is a short orchestrator that calls the AI helper functions in order:

| Step | What happens | AI Concept |
|------|--------------|------------|
| 1 | Validate request with Zod | Runtime type safety |
| 2 | `buildConversation(message)` | **Prompt Engineering** |
| 3 | `convertMcpToolsToOpenAiFormat()` | **Tool Calling** |
| 4 | `runAgenticLoop(messages, tools, mcp, 10)` | **Agentic Loop** |
| 5 | Return response | HTTP response |

Inside the agentic loop, two more helpers handle tool execution:

| Helper | What it does |
|--------|------------|
| `executeSingleToolCall(toolCall, mcp)` | Parse args → validate with Zod → MCP callTool → parse result |
| `executeToolCallsFromLlm(functionCalls, mcp)` | Run a batch of tool calls from one LLM response |

## Learning Console

A live panel in the browser explains every step as it happens. Events stream from the backend using Server-Sent Events (SSE).

What you will see during a chat:

| Event | What it shows |
|-------|---------------|
| `llm_sending_messages` → | Full conversation being sent to the LLM |
| `llm_received_response` ← | What the LLM returned (text, tool calls, or both) |
| `llm_chain_of_thought` | LLM reasoning text when it thinks out loud |
| `llm_tool_selection` | Which tools the LLM chose with exact arguments |
| `llm_tool_results_feeding_back` ↻ | Tool results being added for the next round |
| `llm_response` | Final answer + how the loop ended |

Endpoints:
- `GET /mcp-events` — history snapshot (JSON)
- `GET /mcp-events/stream` — live SSE stream

## Project Structure

```text
mcp-calculator/
├── src/
│   ├── server/
│   │   └── calculator-server.ts    # MCP server (tools live here)
│   ├── client/
│   │   ├── client-backend.ts       # Express + MCP client + AI helpers (the main story)
│   │   ├── trace.ts                # Learning console trace/logging system
│   │   ├── formatters.ts           # Human-readable message summarizers
│   │   ├── mcp-payload.ts          # MCP response parsing and tool normalization
│   │   ├── utils.ts                # Generic runtime helpers (isRecord, getString, etc.)
│   │   └── ui/
│   │       └── app.ts              # Browser-side UI logic
│   └── shared/
│       └── types.ts                # Shared types and Zod schemas
├── public/
│   ├── index.html                  # Calculator + chat + learning console HTML
│   ├── app.js                      # Compiled UI (generated)
│   └── styles.css
├── package.json
├── tsconfig.json
├── tsconfig.server.json
├── tsconfig.client.json
└── README.md
```

### What Each File Does

**`client-backend.ts`** is the main file. Read it top to bottom — it tells the story of how a chat message becomes tool calls and back to an answer. It contains:
- AI helper functions (`buildConversation`, `convertMcpToolsToOpenAiFormat`, `executeSingleToolCall`, `executeToolCallsFromLlm`, `runAgenticLoop`)
- Express routes (`/calculate`, `/chat`, `/tools`, `/mcp-events`)
- MCP client setup and lifecycle

**`calculator-server.ts`** is the MCP server. It registers four tools (add, subtract, multiply, divide), validates arguments with Zod, computes the result, and returns it as typed JSON in MCP text content. It is stateless — every call is independent.

**`types.ts`** holds types and Zod schemas shared between server, backend, and UI. This is how we keep validation consistent across all three layers.

**`trace.ts`** handles the logging and SSE system. Every important event gets formatted into a human-readable explanation and broadcast to connected browsers.

**`formatters.ts`** turns the raw messages array and LLM responses into readable text for the learning console.

**`mcp-payload.ts`** parses MCP responses and normalizes tool definitions. This is plumbing — it handles the messy parts of parsing so the main file stays clean.

**`app.ts`** (browser) manages the calculator UI, chat panel, and learning console. It discovers tools from the backend at startup and validates every response with type guards.

## Runtime Validation with Zod

TypeScript types disappear at runtime. Data crossing boundaries (HTTP, MCP, LLM arguments) arrives as `unknown`. Zod validates it at three places:

1. **HTTP boundary** — browser sends POST to backend
2. **MCP boundary** — backend sends tool call to MCP server
3. **LLM boundary** — OpenAI returns tool names and arguments

This prevents bad data from becoming hidden bugs.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes (for chat) | — | Your OpenAI API key |
| `PORT` | No | `3000` | HTTP server port |
| `MCP_SERVER_ENTRY` | No | Auto-detected | Path to MCP server entry file |

Create a `.env` file in the project root (already in `.gitignore`):

```bash
echo 'OPENAI_API_KEY=sk-...' > .env
```

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

```json
{ "tool": "divide", "args": { "a": 5, "b": 2 } }
```

Success: `{ "result": 2.5, "expression": "5 / 2" }`

Error: `{ "error": "Division by zero is not allowed.", "details": "Provide a non-zero divisor." }`

### `POST /chat`

```json
{ "message": "what is 10 times 5?" }
```

Success:

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

### `GET /healthz`

Returns `{ "status": "ok" }`.

### `GET /mcp-events`

Returns trace history snapshot.

### `GET /mcp-events/stream`

Live Server-Sent Events stream of trace events.

## Contributing

Contributions are welcome. This is an educational project, so clarity matters more than cleverness.

**How to contribute:**

1. Fork the repo
2. Create a branch (`git checkout -b my-change`)
3. Make your changes
4. Make sure `npm run build` passes
5. Open a pull request

**Good first contributions:**
- Add a new MCP tool (e.g., `modulo`, `power`) — the server, types, and UI will all need updating
- Improve learning console explanations
- Add tests
- Fix typos or unclear wording in code comments or README

**Guidelines:**
- Keep code simple and readable — this is a teaching tool
- Every function should be named after what it does
- Short comments over long JSDoc essays
- If you add a feature, update the README

## License

MIT

## Why MCP for a Calculator?

For real math, MCP is overkill. This project is educational.

MCP becomes useful when tools are remote, heterogeneous, or need standardized discovery across multiple clients and servers. This calculator shows all the patterns (handshake, discovery, execution, agentic loop) in a codebase small enough to read in one sitting.
