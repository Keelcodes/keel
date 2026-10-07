# @keelcodes/mcp

A **policy-aware MCP server**: it exposes an agent account's on-chain actions to a
model as [Model Context Protocol](https://modelcontextprotocol.io) tools, and every
action is checked against `@keelcodes/policy` **before it runs**.

The difference between *policy-aware* and *policy-documented* is where the gate
sits. A denied call never reaches the tool handler — the gate stands in front of
`run`, so a misbehaving model cannot talk the account past its policy, and no
amount of prompt injection changes the outcome.

## What it speaks

- Protocol revision **`2025-06-18`** (also accepts `2025-03-26` / `2024-11-05` on
  `initialize`, and answers in the client's version when known).
- Methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`,
  `tools/call`.
- Transport: newline-delimited JSON over stdio — one JSON-RPC 2.0 message per
  line, no embedded newlines.
- Errors use the standard JSON-RPC codes (`-32700`, `-32600`, `-32601`, `-32602`,
  `-32603`). A *policy denial* is **not** a protocol error: it is a tool result
  with `isError: true`, so the reason is visible to the model.

## Built-in tools

`createPolicyTools` ships the three moves an agent needs in front of a
policy-bounded account, in the order it needs them:

| Tool | Gated? | Does |
|---|---|---|
| `keel_policy` | no | Return the commitment hash and the normalised rules. |
| `keel_check_call` | no | Dry-run a call; returns `allowed` plus the refusing rule. |
| `keel_execute_call` | **yes** | Execute — a denied call never reaches the executor. |

Reading and dry-running are deliberately ungated: refusing them would only hide
the policy from the model and push it to guess.

### PIM tools (ERC-8313)

`createPimTools` adds consumption of **Protocol Interaction Manifests** — a PIM
is untrusted JSON, so the model can check it before acting on it. Both tools are
read-only and ungated, and take the manifest inline as `{ pim: <object> }` (this
package never touches the filesystem):

| Tool | Does |
|---|---|
| `pim_validate` | Validate against the nine mandatory sections; returns `{ valid, errors, warnings }`. |
| `pim_inspect` | Summarise protocol/chains/intents/contracts and the assigned trust level (0–3). |

## Install into an MCP client

`keel-mcp` is the packaged entry point — no wrapper script, no globals. It reads
its whole configuration from the environment:

| Variable | Required | Meaning |
|---|---|---|
| `KEEL_POLICY` | yes | The policy as a JSON document, inline, or `@/path/to/policy.json` to read one from disk. |
| `KEEL_EXECUTOR_URL` | no | http(s) endpoint an approved call is `POST`ed to. Without it `keel_execute_call` reports unavailable. |
| `KEEL_EXECUTOR_TOKEN` | no | Bearer token sent to that endpoint. |

It fails fast — message on stderr, non-zero exit — when no policy is configured.
A server that cannot enforce its policy must not pretend to.

The `npx` argument below **pins the exact version**: an agent's policy boundary
must not move because a new `latest` was published, so bump the pin deliberately
when you mean to upgrade.

### Claude Desktop

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "keel": {
      "command": "npx",
      "args": ["-y", "@keelcodes/mcp@0.2.2"],
      "env": { "KEEL_POLICY": "@/absolute/path/to/policy.json" }
    }
  }
}
```

### Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project —
the same `mcpServers` shape as above.

### Cline (VS Code)

MCP Servers → Configure, or `cline_mcp_settings.json` — again the same
`mcpServers` shape.

Instead of a file, the policy can be inlined as one JSON string:

```json
"env": {
  "KEEL_POLICY": "{\"rules\":[{\"target\":\"0x…\",\"maxPerTx\":\"1000000000000000000\"}]}"
}
```

## Use as a library

```ts
import { createMcpServer, createPolicyGate, createPolicyTools, serveStdio } from '@keelcodes/mcp';
import type { Policy } from '@keelcodes/policy';

const policy: Policy = /* normalisePolicy({ … }) */;

const server = createMcpServer({
  name: 'keel',
  version: '0.2.2',
  tools: createPolicyTools({
    policy,
    // Wire this to a bundler/paymaster; without it keel_execute_call reports unavailable.
    executor: async (call) => ({ transactionHash: '0x…' }),
  }),
  gate: createPolicyGate({ policy }),
});

serveStdio({ server, input: process.stdin, output: process.stdout });
```

To skip the wiring, `readEnvConfig(process.env, (path) => readFileSync(path, 'utf8'))`
returns exactly the `{ policy, executor }` the bin feeds in, and
`createHttpExecutor` implements the endpoint `POST` that consumes
`KEEL_EXECUTOR_URL`.

When no policy is configured, use the safe default `DENY_ALL`: the server can still
describe itself and dry-run, but it cannot execute. That is "cannot act", never
"acts by default".

## Design

- **One source of truth.** The gate calls `evaluateCall` from `@keelcodes/policy` —
  the same function the on-chain hook mirrors — so an MCP verdict and the eventual
  transaction cannot disagree.
- **Ports, not wiring.** `PolicyGate`, `CallExecutor` and `serveStdio`'s
  `ReadableLike` / `WritableLike` are structural interfaces, so tests inject fakes
  and the transport stays free of `@types/node`; only the `keel-mcp` bin entry
  point touches Node.

## Develop

```bash
pnpm --filter @keelcodes/mcp build
pnpm --filter @keelcodes/mcp test
```

The integration point is described in the internal Keel plan
([`docs/internal/KEEL_PLAN.md`](../../docs/internal/KEEL_PLAN.md) §4.4 ⑥).
