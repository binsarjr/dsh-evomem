# dsh-evomem

Out-of-tree DeepSeek Harness plugin that exposes the [evomem](https://github.com/anvie/evomem)
memory tools and routes each call to a **per-workspace namespace** automatically.

One `evomem-mcp-rs` server (see sibling `../evomem-mcp-rs`) backs every workspace.
The namespace is derived from the current session's workspace directory name, so
the model never sees, chooses, or passes a namespace — switching workspace
switches the memory, and there is zero per-workspace configuration.

## How it works

1. The plugin mirrors the server's lean three-tool surface (`memory_remember`,
   `memory_recall`, `memory_forget`) one-to-one — see `../evomem-mcp-rs`.
2. On every tool call it reads the session's workspace from
   `agent.session.header.cwd` and computes `namespace = slug(basename(cwd))`.
3. It calls the server with that namespace in the `X-Evomem-Namespace` header,
   keeping one MCP session per namespace.

That is the whole point of the plugin: the server is namespace-agnostic (the
namespace rides an HTTP header), and this plugin supplies that header from the
session's workspace — so switching workspace switches memory with zero
per-workspace configuration.

## Exposed tools

Only these three are visible to the model (a one-to-one pass-through to the
server):

- `memory_remember` (`text*`, `title?`, `tags?`)
- `memory_recall` (`query*`, `mode?`, `edge?`, `hops?`)
- `memory_forget` (`slug*`)

`mode` on `memory_recall` is `search` (default) | `think` | `graph`. `edge`/`hops`
apply only to `graph` mode (where `query` is the start entity). No tool takes a
`namespace` argument — the namespace always follows the session workspace.

## Model guidance

The plugin contributes a persistent system-prompt section (`evomem:memory`,
order 113) plus tool descriptions that teach the model how to structure memory:

- capture durable facts with `memory_remember`, recall with `memory_recall`
  (`mode: search | think | graph`);
- wrap entity names in `[[Name]]` so they wire into the knowledge graph;
- use a relation verb ("works at", "founded") for a typed edge;
- pass meaningful lowercase `tags` (`person`, `project`, `meeting`, …) instead
  of leaving the default `["captured"]`;
- delete obsolete memories with `memory_forget`.

## Install

From the directory that contains this checkout:

```sh
dsh plugin --profile web add ./evomem-dsh
```

Verify the layer, then boot:

```sh
dsh --profile web --dump-config | grep -A4 evomem
dsh web
```

## Config

The evomem MCP server URL comes from the `EVOMEM_MCP_URL` environment variable
(no URL is hardcoded anywhere in this repo):

```sh
export EVOMEM_MCP_URL=http://your-server:8090/mcp
```

The plugin reads `config.url` first, then `EVOMEM_MCP_URL`; if neither is set it
logs an error and leaves the memory tools disabled. The namespace is never a
config value — it always follows the session workspace.

## Team (multi-author) mode

Set `EVOMEM_AUTHOR` to pin your `memory_remember`/`memory_forget` writes to your
own folder inside the shared workspace namespace:

```sh
export EVOMEM_AUTHOR=binsar
```

When set, the plugin sends it as the `X-Evomem-Author` header (same pattern as
the namespace header). `memory_recall` still searches the whole namespace, so a
team can share one workspace while each member's writes stay in their own
folder. Leave it unset for the single-user default (`inbox`). The server
lowercases and validates the name (`a-z0-9_-`); `test` and `attachments` are
reserved and rejected.

## Namespace rules

The namespace is the workspace folder name lowercased with any character
outside `[a-z0-9_-]` replaced by `-` (leading/trailing `-` trimmed). An empty
result falls back to `default`, matching the server's
`EVOMEM_DEFAULT_NAMESPACE`. Two workspaces whose folder names slugify to the
same string share one namespace, so keep workspace folder names distinct.
