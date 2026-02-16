# MCP Calculator (TypeScript)

This project is a fully working calculator built to demonstrate MCP (Model Context Protocol) as a client-server RPC layer.

It intentionally uses a simple domain (calculator math) so you can focus on protocol flow:
- MCP handshake
- tool discovery
- remote tool execution
- typed error propagation

## Project Structure

```text
mcp-calculator/
├── src/
│   ├── server/
│   │   └── calculator-server.ts
│   ├── client/
│   │   ├── client-backend.ts
│   │   └── ui/
│   │       └── app.ts
│   └── shared/
│       └── types.ts
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── package.json
├── tsconfig.json
├── tsconfig.server.json
├── tsconfig.client.json
└── README.md
```

## Setup

```bash
npm install
npm run build
# In terminal 1:
npm run start:client
# In terminal 2 (optional for direct MCP server run):
npm run start:server
# Open browser:
# http://localhost:3000
```

## Development Mode

```bash
npm run dev
```

`npm run dev` builds and starts the client backend, which automatically spawns the MCP server process over stdio.

## MCP Learning Console (UI)

The calculator UI includes a live, user-facing console that explains MCP flow in plain language.

- Phase 1: handshake
- Phase 2: tool discovery
- Phase 3: tool execution

Events stream from backend using Server-Sent Events:
- `GET /mcp-events` (history snapshot)
- `GET /mcp-events/stream` (live updates)

## Architecture

```text
┌───────────────────────────┐
│ Web UI (public/index.html)│
│ + TypeScript UI app       │
│ State: input/operator/etc │
└───────────────┬───────────┘
                │ HTTP (typed JSON)
                ▼
┌───────────────────────────┐
│ Express Client Backend    │
│ src/client/client-backend │
│ - Zod request validation  │
│ - MCP client handshake    │
│ - listTools discovery     │
│ - callTool proxy          │
└───────────────┬───────────┘
                │ MCP over stdio
                ▼
┌───────────────────────────┐
│ MCP Calculator Server     │
│ src/server/calculator-... │
│ - 4 tools (add/sub/mul/div)│
│ - JSON Schema definitions │
│ - Zod argument validation │
│ - stateless execution     │
└───────────────────────────┘
```

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
4. `/tools` endpoint exposes discovered tools for the UI.

### Phase 3: Tool Execution

For `5 + 3 =`:
1. UI POSTs `/calculate` with `{ tool: "add", args: { a: 5, b: 3 } }`.
2. Backend validates payload with Zod.
3. Backend calls `client.callTool(...)`.
4. MCP server validates args with Zod, computes result, returns payload.
5. Backend formats `{ result, expression }`.
6. UI displays `8`.

## Why Zod if TypeScript Exists?

TypeScript types are erased at runtime. Network/process boundaries still receive `unknown` data.

Zod gives runtime guarantees at:
- HTTP boundary (UI -> backend)
- MCP boundary (backend -> MCP server)

This prevents invalid payloads from becoming hidden runtime bugs.

## Stateless MCP Server Design

Calculator state (first number, selected operation, second number) is managed entirely in the UI.

The MCP server remains stateless by design:
- easier to scale
- safer for concurrent calls
- cleaner RPC mental model

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
  "args": { "a": 5, "b": 0 }
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

## Sample Logs

### Client Backend

```text
{"level":"INFO","component":"client-backend","event":"mcp_phase_1_initialization_started", ...}
{"level":"INFO","component":"client-backend","event":"mcp_phase_1_handshake_complete", ...}
{"level":"INFO","component":"client-backend","event":"mcp_phase_2_discovery_complete","toolCount":4,...}
{"level":"INFO","component":"client-backend","event":"mcp_phase_3_tool_execution_started","tool":"add","args":{"a":5,"b":3}}
```

### MCP Server (stderr)

```text
{"level":"INFO","component":"mcp-calculator-server","event":"startup_begin", ...}
{"level":"INFO","component":"mcp-calculator-server","event":"tools_list_requested","toolCount":4}
{"level":"INFO","component":"mcp-calculator-server","event":"tool_call_succeeded","tool":"add","a":5,"b":3,"result":8}
```

### UI (browser console)

```text
[ui] calculate_request { tool: "add", args: { a: 5, b: 3 } }
[ui] calculate_response_success { result: 8, expression: "5 + 3" }
```

## Why MCP for a Calculator?

For production math, MCP is unnecessary. This project is educational and intentionally overkill.

Real MCP value appears when:
- tools are remote and heterogeneous
- LLM agents need standardized tool discovery/calling
- you need protocol-level interoperability across clients/servers

## GitHub Readiness Checklist

- Strict TypeScript enabled
- Runtime validation with Zod on both boundaries
- Structured logs at all layers
- Clear folder structure and scripts
- Documented architecture and flow
