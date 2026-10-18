import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import { ctx } from '../../tools/__tests__/helpers.js';
import { ToolRegistry } from '../../tools/ToolRegistry.js';
import { McpConfigSchema } from '../config.js';
import { McpToolSource } from '../McpToolSource.js';

const SERVER = resolve(import.meta.dir, '../../../../tests/fixtures/mcp-test-server.mjs');
const config = (extra: Record<string, any> = {}) =>
  McpConfigSchema.parse({ servers: { demo: { transport: 'stdio', command: 'node', args: [SERVER], toolTimeoutMs: 3000, ...extra } } });

let source: McpToolSource;
afterAll(async () => { await source?.stop(); });

const call = async (name: string, args: Record<string, unknown>) => {
  const tool = source.listTools().find((t) => t.name === name)!;
  return (await tool.build(ctx({ scopes: ['mcp'] })).invoke({ name, args, id: `c-${Math.random()}`, type: 'tool_call' })) as ToolMessage;
};

describe('McpToolSource with a REAL stdio MCP server', () => {
  beforeAll(async () => {
    source = new McpToolSource(config(), { reconnectBaseMs: 100, reconnectMaxMs: 400, connectTimeoutMs: 15_000, logger: { warn() {}, info() {} } });
    await source.start();
  });

  it('connects over stdio and discovers the server\'s tools (prefixed by server name)', async () => {
    expect(source.serverStatus().demo!.status).toBe('up');
    expect(source.listTools().map((t) => t.name).sort()).toEqual(['demo_add', 'demo_crash', 'demo_echo', 'demo_slow']);
    expect((await source.checkHealth()).status).toBe('up');
  });

  it('executes tools and fences their output as untrusted', async () => {
    const msg = await call('demo_echo', { text: 'hello mcp' });
    expect(String(msg.content)).toContain('<untrusted tool="demo_echo" server="demo">');
    expect(String(msg.content)).toContain('echo: hello mcp');
    expect(String((await call('demo_add', { a: 2, b: 40 })).content)).toContain('42');
  });

  it('is gated by the "mcp" scope through the registry', () => {
    const reg = new ToolRegistry().addSource(source);
    expect(reg.authorizedFor(ctx({ scopes: ['kb:read', 'web'] }))).toEqual([]);
    expect(reg.authorizedFor(ctx({ scopes: ['mcp'] })).length).toBe(4);
  });

  it('times out slow tool calls without hanging the agent', async () => {
    const t = Date.now();
    const msg = await call('demo_slow', { ms: 10_000 });
    expect(Date.now() - t).toBeLessThan(6000);
    expect(String(msg.content)).toContain('ERROR');
  });

  it('SERVER CRASH: the call becomes a tool error, the source degrades, then reconnects by itself', async () => {
    const msg = await call('demo_crash', {});
    expect(String(msg.content)).toContain('ERROR');
    expect(['down', 'connecting', 'up']).toContain(source.serverStatus().demo!.status);
    // wait for the background reconnect (fresh process) and verify the tools work again
    for (let i = 0; i < 100 && !(source.serverStatus().demo!.status === 'up' && source.listTools().length === 4); i++) await new Promise((r) => setTimeout(r, 100));
    expect(source.serverStatus().demo!.status).toBe('up');
    expect(String((await call('demo_echo', { text: 'after crash' })).content)).toContain('after crash');
  });
});

describe('startup with a broken server config', () => {
  it('a server that cannot start never blocks startup or other servers', async () => {
    const cfg = McpConfigSchema.parse({
      servers: {
        good: { transport: 'stdio', command: 'node', args: [SERVER] },
        broken: { transport: 'stdio', command: 'definitely-not-a-real-binary-xyz', args: [] },
      },
    });
    const src = new McpToolSource(cfg, { reconnectBaseMs: 5000, connectTimeoutMs: 10_000, logger: { warn() {}, info() {} } });
    const t = Date.now();
    await src.start();
    try {
      expect(Date.now() - t).toBeLessThan(12_000);
      expect(src.serverStatus().good!.status).toBe('up');
      expect(src.serverStatus().broken!.status).toBe('down');
      expect(src.listTools().every((x) => x.name.startsWith('good_'))).toBe(true);
      expect((await src.checkHealth()).status).toBe('degraded');
    } finally { await src.stop(); }
  });
});
