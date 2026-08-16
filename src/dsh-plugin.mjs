/**
 * dsh-evomem — out-of-tree DeepSeek Harness plugin.
 *
 * Registers three memory tools (memory_remember, memory_recall, memory_forget)
 * as a thin pass-through to evomem-mcp-rs, and routes every call to the
 * namespace derived from the CURRENT session's workspace directory
 * (`SessionHeader.cwd`). One evomem-mcp-rs server serves many workspaces; the
 * model never sees or chooses a namespace.
 *
 * Pure ESM, no runtime dependencies beyond Node 22 built-ins (global `fetch`,
 * `node:path`) and the services the harness injects via `inject`.
 */
import { basename } from 'node:path'

export const name = 'dsh-evomem'
export const inject = ['tools', 'systemPrompt']

const PROTOCOL_VERSION = '2025-11-25'

/** Persistent reminder: how to structure memory for graph + search quality. */
const MEMORY_GUIDANCE =
  'Memory (evomem): capture durable facts with memory_remember, recall them ' +
  'with memory_recall (mode: search | think | graph). Wrap entity names in ' +
  '[[Name]] (people, projects, organizations, places) so they wire into the ' +
  'knowledge graph; use a relation verb in the same sentence ("works at", ' +
  '"founded", "advises") for a typed edge, otherwise the link defaults to ' +
  '"mentions". Pass 1-4 meaningful lowercase tags (person, project, meeting, ' +
  'decision, preference, ...) instead of the default. Delete obsolete memories ' +
  'with memory_forget.'

/** Map a workspace directory name to a safe evomem namespace segment. */
function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default'
}

/** Namespace for one tool call = slugified basename of the session workspace. */
function namespaceFor(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return slugify(basename(cwd || process.cwd()))
}

let nextId = 1

/** Extract the JSON-RPC message out of a Streamable HTTP (SSE) response body. */
function parseSse(body) {
  const lines = String(body).split(/\r?\n/)
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload.startsWith('{')) continue
    try {
      const message = JSON.parse(payload)
      if (message && typeof message === 'object' && ('result' in message || 'error' in message)) {
        return message
      }
    } catch {
      // Not a JSON-RPC payload; keep scanning the SSE stream.
    }
  }
  throw new Error('evomem: no JSON-RPC message in Streamable HTTP response')
}

/** One MCP session per namespace, cached by namespace. */
const sessions = new Map()

function baseHeaders(namespace) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
    'X-Evomem-Namespace': namespace,
  }
}

async function rpc(url, namespace, sessionId, method, params) {
  const headers = baseHeaders(namespace)
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }),
  })
  if (!response.ok) {
    throw new Error(`evomem: HTTP ${response.status} ${await response.text()}`)
  }
  return parseSse(await response.text())
}

async function ensureSession(url, namespace) {
  const cached = sessions.get(namespace)
  if (cached) return cached

  const init = await fetch(url, {
    method: 'POST',
    headers: baseHeaders(namespace),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-evomem', version: '0.1.0' },
      },
    }),
  })
  if (!init.ok) throw new Error(`evomem: initialize HTTP ${init.status}`)
  const sessionId = init.headers.get('mcp-session-id')
  if (!sessionId) throw new Error('evomem: initialize returned no Mcp-Session-Id')

  // Acknowledge initialization (notification, no id).
  await fetch(url, {
    method: 'POST',
    headers: { ...baseHeaders(namespace), 'Mcp-Session-Id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })

  sessions.set(namespace, sessionId)
  return sessionId
}

async function callTool(url, namespace, toolName, args) {
  const sessionId = await ensureSession(url, namespace)
  try {
    return await rpc(url, namespace, sessionId, 'tools/call', { name: toolName, arguments: args ?? {} })
  } catch (error) {
    // The session may have expired (server restart): drop it and retry once.
    sessions.delete(namespace)
    const fresh = await ensureSession(url, namespace)
    return await rpc(url, namespace, fresh, 'tools/call', { name: toolName, arguments: args ?? {} })
  }
}

function renderJson(_args, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return [{ type: 'text', text }]
}

/** Extract the canonical JSON value from an MCP tools/call result. */
function canonicalValue(result) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const first = (result.content ?? [])[0]
  if (first && typeof first.text === 'string') {
    try {
      return JSON.parse(first.text)
    } catch {
      return first.text
    }
  }
  return null
}

/** Run one server tool under the current session's namespace and unwrap its value. */
async function runTool(url, serverTool, args, exec) {
  const namespace = namespaceFor(exec)
  const message = await callTool(url, namespace, serverTool, args)
  if (message.error) throw new Error(JSON.stringify(message.error))
  const result = message.result ?? {}
  if (result.isError) {
    const text = (result.content ?? [])
      .map((block) => block?.text ?? '')
      .join('\n')
      .trim()
    throw new Error(text || `${serverTool} returned an error`)
  }
  return canonicalValue(result)
}

/** The model-facing tool surface (thin pass-through to the server's three tools). */
function toolDefinitions(url) {
  return [
    {
      name: 'memory_remember',
      description:
        'Remember a durable fact/thought into long-term memory (indexed ' +
        'immediately). Wrap entity names in [[Name]] to wire the knowledge ' +
        'graph (e.g. "[[Alice]] works at [[Nuwaira]]"); use a relation verb ' +
        '("works at", "founded") for a typed edge. Pass 1-4 lowercase tags.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact/thought to remember.' },
          title: { type: 'string', description: 'Optional title (derived from text if omitted).' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase tags (person, project, meeting, decision, preference, ...).' },
        },
        required: ['text'],
      },
      output: { schema: {}, render: renderJson },
      execute: (args, exec) => runTool(url, 'memory_remember', args, exec),
    },
    {
      name: 'memory_recall',
      description:
        'Recall from long-term memory. mode "search" (default): hybrid ' +
        'keyword+vector lookup. mode "think": synthesize facts with citations ' +
        'and knowledge gaps. mode "graph": traverse the knowledge graph from ' +
        'an entity (query = entity name; use edge/hops to steer).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to recall (entity name for graph mode).' },
          mode: { type: 'string', enum: ['search', 'think', 'graph'], description: 'search (default) | think | graph.' },
          edge: { type: 'string', description: 'Graph mode only: filter by edge type (works_at, founded, advises, attended, invested_in, mentions).' },
          hops: { type: 'integer', description: 'Graph mode only: traversal depth (default 2).' },
        },
        required: ['query'],
      },
      output: { schema: {}, render: renderJson },
      execute: (args, exec) => runTool(url, 'memory_recall', args, exec),
    },
    {
      name: 'memory_forget',
      description:
        'Forget (delete) a memory document by slug, title, or alias. It stops ' +
        'appearing in memory_recall results.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Slug, title, or alias of the memory to delete.' },
        },
        required: ['slug'],
      },
      output: { schema: {}, render: renderJson },
      execute: (args, exec) => runTool(url, 'memory_forget', { slug: args.slug }, exec),
    },
  ]
}

export async function apply(ctx, config) {
  const url = config?.url || process.env.EVOMEM_MCP_URL
  if (!url) {
    ctx.logger?.error?.(
      'dsh-evomem: EVOMEM_MCP_URL env var (or config.url) is required; memory tools disabled'
    )
    return
  }

  // Persistent guidance so the model structures memory correctly (wikilinks
  // wire the graph; tags categorize notes; recall modes cover retrieval).
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'evomem:memory',
    order: 113,
    text: MEMORY_GUIDANCE,
  }), 'evomem.memory-guidance')

  const disposers = []
  // Register cleanup first so a mid-loop registration failure rolls back
  // every already-registered tool.
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'evomem.tools')

  for (const definition of toolDefinitions(url)) {
    disposers.push(ctx.tools.register(definition))
  }

  ctx.logger?.info?.(`evomem: exposed ${disposers.length} tools (url: ${url})`)
}
