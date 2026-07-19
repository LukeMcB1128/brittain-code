// A minimal MCP server speaking JSON-RPC 2.0 over stdio, used to test mcp.js.
// Tools: echo (returns its input), slow (sleeps), fail (isError result), die (exits).
const readline = require('readline');

const tools = [
  { name: 'echo', description: 'Echo back the message', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
  { name: 'slow', description: 'Sleep for ms milliseconds', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  { name: 'fail', description: 'Return an error result', inputSchema: { type: 'object', properties: {} } },
  { name: 'die', description: 'Exit the process', inputSchema: { type: 'object', properties: {} } },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification

  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });

  if (msg.method === 'initialize') {
    reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0' } });
  } else if (msg.method === 'tools/list') {
    reply({ tools });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params;
    if (name === 'echo') reply({ content: [{ type: 'text', text: 'echo: ' + args.message }] });
    else if (name === 'slow') setTimeout(() => reply({ content: [{ type: 'text', text: 'woke up' }] }), args.ms || 100);
    else if (name === 'fail') reply({ content: [{ type: 'text', text: 'something broke' }], isError: true });
    else if (name === 'die') process.exit(3);
    else send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown tool ' + name } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method ' + msg.method } });
  }
});
