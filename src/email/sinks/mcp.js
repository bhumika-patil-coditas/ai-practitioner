// MCP sink: creates the draft through a configured MCP stdio server (e.g. a Gmail MCP server).
// Guard order: refuse send-like tool names → verify the server really offers the draft tool → single tools/call.
import { SinkError } from '../../errors.js';
import { McpClient, assertNotSend } from '../mcp-client.js';

/**
 * @param {import('../../config.js').McpConfig|null} cfg
 * @param {{clientFactory?: (c: any) => McpClient}} [deps] injectable for tests
 */
export function createMcpSink(cfg, { clientFactory = (c) => new McpClient(c) } = {}) {
  if (!cfg) {
    throw new SinkError('sink "mcp" needs "followup.mcp" in the config (command, args, tool) — see actiontrack.config.example.json');
  }
  assertNotSend(cfg.tool); // fail before any process is spawned
  /** @type {McpClient|null} */
  let client = null;

  return {
    name: 'mcp',
    async createDraft(payload) {
      if (!client) {
        client = clientFactory(cfg);
        await client.start();
        const tools = await client.listTools();
        if (!tools.some((t) => t.name === cfg.tool)) {
          const offered = tools.map((t) => t.name).join(', ') || 'none';
          await client.close();
          client = null;
          throw new SinkError(`MCP server does not offer the draft tool "${cfg.tool}" (offers: ${offered})`);
        }
      }
      const res = await client.callTool(cfg.tool, { to: payload.to, subject: payload.subject, body: payload.body });
      const text = (res?.content ?? []).map((c) => c.text ?? '').join('\n');
      if (res?.isError) throw new SinkError(`MCP tool "${cfg.tool}" failed: ${text || 'unknown error'}`);
      return { status: 'drafted', id: extractId(text) };
    },
    async close() {
      if (client) { await client.close(); client = null; }
    },
  };
}

/** Best-effort extraction of a draft id from the tool's text result (JSON or "id: abc123"). */
export function extractId(text) {
  if (!text) return undefined;
  try {
    const j = JSON.parse(text);
    const id = j.id ?? j.draftId ?? j.draft?.id;
    if (id) return String(id);
  } catch { /* not JSON */ }
  const m = /\b(?:draft[_ ]?id|id)["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/i.exec(text);
  return m ? m[1] : undefined;
}
