// Minimal MCP (Model Context Protocol) stdio client: newline-delimited JSON-RPC 2.0.
// It can only do four things: initialize, list tools, call ONE tool, close — and `callTool` refuses anything that looks
// like sending mail. This is the structural half of "actiontrack never sends" (FR-F5).
import { spawn } from 'node:child_process';
import { SinkError } from '../errors.js';

export const SEND_PATTERN = /send/i;

/** @param {string} toolName */
export function assertNotSend(toolName) {
  if (SEND_PATTERN.test(toolName)) {
    throw new SinkError(`refusing to use MCP tool "${toolName}": actiontrack only creates drafts and never sends email`);
  }
}

export class McpClient {
  /**
   * @param {{command: string, args?: string[], timeoutMs?: number, spawnFn?: typeof spawn}} opts
   */
  constructor({ command, args = [], timeoutMs = 20000, spawnFn = spawn }) {
    this.command = command;
    this.args = args;
    this.timeoutMs = timeoutMs;
    this.spawnFn = spawnFn;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = '';
    this.exited = false;
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
  }

  async start() {
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnFn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
      } catch (err) {
        reject(new SinkError(`cannot start MCP server "${this.command}": ${err.message}`));
        return;
      }
      this.child = child;
      child.once('error', (err) => {
        this.failAll(new SinkError(`cannot start MCP server "${this.command}": ${err.message}`));
        reject(new SinkError(`cannot start MCP server "${this.command}": ${err.message}`));
      });
      child.once('spawn', resolve);
      child.stdin.on('error', () => { /* server went away; the exit handler reports it */ });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.onData(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { this.stderrTail = (this.stderrTail + chunk).slice(-2000); });
      child.once('exit', (code) => {
        this.exited = true;
        this.failAll(new SinkError(`MCP server exited (code ${code})${this.stderrTail ? `: ${this.stderrTail.trim()}` : ''}`));
      });
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'actiontrack', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
  }

  onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // tolerate stray log lines on stdout
      if (msg.id === undefined || !this.pending.has(msg.id)) continue; // notifications / server requests are ignored
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new SinkError(`MCP error ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }

  failAll(err) {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(err); this.pending.delete(id); }
  }

  request(method, params) {
    if (this.exited) return Promise.reject(new SinkError('MCP server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SinkError(`MCP request "${method}" timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  }

  /** @returns {Promise<{name: string}[]>} */
  async listTools() {
    const res = await this.request('tools/list', {});
    return res?.tools ?? [];
  }

  /** The single entry point for tool calls. Send-like tools can never pass through it. */
  async callTool(name, args) {
    assertNotSend(name);
    return this.request('tools/call', { name, arguments: args });
  }

  async close() {
    if (!this.child || this.exited) return;
    try { this.child.stdin.end(); } catch { /* already closed */ }
    await new Promise((resolve) => {
      const kill = setTimeout(() => { try { this.child.kill(); } catch { /* gone */ } }, 500);
      this.child.once('exit', () => { clearTimeout(kill); resolve(); });
      if (this.exited) { clearTimeout(kill); resolve(); }
    });
  }
}
