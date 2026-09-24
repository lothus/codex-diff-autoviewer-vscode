import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { insideWorkspace, isEditEvent, startBridge } from './bridge';

// Send an HTTP event to a local bridge and return its response status.
async function post(port: number, token: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/v1/events', method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end(body);
  });
}

// Check path boundaries and stale event rejection independently of the listener.
test('validates event shape and workspace boundaries', () => {
  assert.equal(insideWorkspace('/workspace/file.ts', ['/workspace']), true);
  assert.equal(insideWorkspace('/workspace-other/file.ts', ['/workspace']), false);
  assert.equal(isEditEvent({ version: 1, path: '/tmp/a', operation: 'modify',
    sessionId: null, turnId: null, timestamp: Date.now() - 60_000 }), false);
});

// Check authenticated delivery, path scope, and descriptor cleanup end to end.
test('accepts only fresh authenticated files from this workspace', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'codex-bridge-test-'));
  const workspace = path.join(directory, 'workspace');
  const elsewhere = path.join(directory, 'elsewhere.ts');
  await fs.mkdir(workspace);
  const inside = path.join(workspace, 'inside.ts');
  await fs.writeFile(inside, 'ok');
  await fs.writeFile(elsewhere, 'no');
  const escapingLink = path.join(workspace, 'outside-link.ts');
  if (process.platform !== 'win32') await fs.symlink(elsewhere, escapingLink);
  const received: string[] = [];
  const bridge = await startBridge([workspace], async event => { received.push(event.path); });
  try {
    const descriptor = JSON.parse(await fs.readFile(bridge.descriptorPath, 'utf8')) as {
      port: number; token: string;
    };
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(bridge.descriptorPath)).mode & 0o077, 0);
    }
    const event = { version: 1, path: inside, operation: 'modify',
      sessionId: null, turnId: null, timestamp: Date.now() };
    assert.equal(await post(descriptor.port, 'wrong', JSON.stringify(event)), 401);
    assert.equal(await post(descriptor.port, descriptor.token, JSON.stringify({ ...event, path: elsewhere })), 400);
    if (process.platform !== 'win32') {
      assert.equal(await post(descriptor.port, descriptor.token,
        JSON.stringify({ ...event, path: escapingLink })), 400);
    }
    assert.equal(await post(descriptor.port, descriptor.token,
      JSON.stringify({ ...event, timestamp: Date.now() - 60_000 })), 400);
    assert.equal(await post(descriptor.port, descriptor.token, `${JSON.stringify(event)}${' '.repeat(8192)}`), 400);
    assert.equal(await post(descriptor.port, descriptor.token, JSON.stringify(event)), 204);
    assert.deepEqual(received, [inside]);
  } finally {
    await bridge.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
  await assert.rejects(fs.stat(bridge.descriptorPath));
});
