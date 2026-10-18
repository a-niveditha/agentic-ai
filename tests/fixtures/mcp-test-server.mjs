// Minimal real MCP server over stdio (newline-delimited JSON-RPC 2.0) for integration tests.
// Tools: echo {text}, add {a,b}, crash {} (kills the server), slow {ms}.
import readline from 'node:readline';

const tools = [
  { name: 'echo', description: 'Echo the given text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'crash', description: 'Crashes the server process.', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'Sleeps for ms milliseconds.', inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] } },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const text = (t) => ({ content: [{ type: 'text', text: t }] });

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (id === undefined) return; // notification
  try {
    switch (method) {
      case 'initialize':
        return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test-server', version: '1.0.0' } } });
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools } });
      case 'tools/call': {
        const { name, arguments: args = {} } = params;
        if (name === 'echo') return send({ jsonrpc: '2.0', id, result: text(`echo: ${args.text}`) });
        if (name === 'add') return send({ jsonrpc: '2.0', id, result: text(String(Number(args.a) + Number(args.b))) });
        if (name === 'slow') { await new Promise((r) => setTimeout(r, Number(args.ms))); return send({ jsonrpc: '2.0', id, result: text('slept') }); }
        if (name === 'crash') process.exit(1);
        return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${name}` } });
      }
      default:
        return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e) } });
  }
});
