// A tiny fake MCP stdio server for tests. Newline-delimited JSON-RPC 2.0.
//   FAKE_MCP_TOOLS  comma-separated tool names to advertise (default "create_draft")
//   FAKE_MCP_LOG    file to append one JSON line per received request (method + tool name)
//   FAKE_MCP_MODE   ok (default) | tool-error | hang | crash   (behaviour on tools/call)
import fs from 'node:fs';
import readline from 'node:readline';

const tools = (process.env.FAKE_MCP_TOOLS ?? 'create_draft').split(',').filter(Boolean);
const logFile = process.env.FAKE_MCP_LOG;
const mode = process.env.FAKE_MCP_MODE ?? 'ok';
let drafts = 0;

const log = (entry) => { if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`); };
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  log({ method: msg.method, tool: msg.params?.name, args: msg.params?.arguments });
  if (msg.id === undefined) return; // notification
  if (msg.method === 'initialize') {
    return reply(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0.0.1' } });
  }
  if (msg.method === 'tools/list') {
    return reply(msg.id, { tools: tools.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) });
  }
  if (msg.method === 'tools/call') {
    if (mode === 'hang') return undefined;
    if (mode === 'crash') process.exit(3);
    if (mode === 'tool-error') return reply(msg.id, { isError: true, content: [{ type: 'text', text: 'quota exceeded' }] });
    drafts += 1;
    return reply(msg.id, { content: [{ type: 'text', text: JSON.stringify({ id: `draft-${drafts}`, viewUrl: 'https://example.invalid/d' }) }] });
  }
  return process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })}\n`);
});
