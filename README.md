# dsh-evomem

Out-of-tree DeepSeek Harness plugin that exposes the [evomem](https://github.com/anvie/evomem)
memory tools and routes each call to a **per-workspace namespace** automatically.

One `evomem-mcp-rs` server (see sibling `../evomem-mcp-rs`) backs every workspace.
The namespace is derived from the current session's workspace directory name, so
the model never sees, chooses, or passes a namespace — switching workspace
switches the memory, and there is zero per-workspace configuration.

## How it works

1. The plugin hardcodes three consolidated tools (`memory_remember`,
   `memory_recall`, `memory_forget`) that map onto the server's finer-grained
   tools — the model sees a small, evonic-style surface.
2. On every tool call it reads the session's workspace from
   `agent.session.header.cwd` and computes `namespace = slug(basename(cwd))`.
3. It calls the server with that namespace in the `X-Evomem-Namespace` header,
   keeping one MCP session per namespace.

## Exposed tools

Only these three are visible to the model:

- `memory_remember` (`text*`, `title?`, `tags?`) → server `memory_capture`
- `memory_recall` (`query*`, `mode?`, `edge?`, `hops?`) → server
  `memory_search` / `memory_think` / `memory_graph` by `mode`
- `memory_forget` (`slug*`) → server `memory_forget`

`mode` on `memory_recall` is `search` (default) | `think` | `graph`. `edge`/`hops`
apply only to `graph` mode (where `query` is the start entity).

Hidden on purpose: `memory_get_doc`, `memory_list_namespaces` (leaks other
namespaces), `memory_init` (auto-initialized by the server), `memory_sync`
(`capture` already auto-indexes), and `memory_stats` (admin-only). No tool takes
a `namespace` argument — the namespace always follows the session workspace.

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

`cordis.patch.yml` carries the only setting:

```yaml
config:
  url: http://raspberrypi.local:8090/mcp
```

`url` is the evomem MCP Streamable HTTP endpoint. The namespace is never a
config value — it always follows the session workspace.

## Namespace rules

The namespace is the workspace folder name lowercased with any character
outside `[a-z0-9_-]` replaced by `-` (leading/trailing `-` trimmed). An empty
result falls back to `default`, matching the server's
`EVOMEM_DEFAULT_NAMESPACE`. Two workspaces whose folder names slugify to the
same string share one namespace, so keep workspace folder names distinct.
