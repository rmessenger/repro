import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
test('MCP handshake advertises compact capture tools and validated inputs', async () => {
  const client = new Client({ name: 'evidence-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp.js', import.meta.url))] });
  await client.connect(transport);
  try {
    const result = await client.listTools();
    assert.deepEqual(result.tools.map(tool => tool.name).sort(), ['capture_callout', 'capture_include', 'capture_release', 'capture_screenshot', 'capture_start', 'capture_status', 'capture_stop', 'capture_wait']);
    const obsolete = await client.callTool({ name: 'capture_start', arguments: { tabId: 1, url: 'https://example.com', region: { testId: 'dialog' } } });
    assert.equal(obsolete.isError, true);
    assert.match(obsolete.content[0].text, /Unrecognized key.*region/);
    const invalid = await client.callTool({ name: 'capture_start', arguments: { maxSeconds: -1 } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});
