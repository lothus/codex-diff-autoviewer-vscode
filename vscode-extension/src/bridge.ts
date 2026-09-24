import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MAX_BODY_BYTES = 8192;
const MAX_EVENT_AGE_MS = 30_000;
const DESCRIPTOR_NAME = 'bridge.json';

export interface EditEvent {
  version: 1;
  path: string;
  operation: 'create' | 'modify' | 'rename';
  sessionId: string | null;
  turnId: string | null;
  timestamp: number;
}

export interface Bridge {
  descriptorPath: string;
  close(): Promise<void>;
}

// Check that a resolved path stays within one of this window's workspace folders.
export function insideWorkspace(file: string, folders: readonly string[]): boolean {
  return folders.some(folder => {
    const relative = path.relative(folder, file);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);
  });
}

// Validate the event shape before using any data from the request.
export function isEditEvent(value: unknown, now = Date.now()): value is EditEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.version === 1 && typeof event.path === 'string' && path.isAbsolute(event.path) &&
    ['create', 'modify', 'rename'].includes(String(event.operation)) &&
    (event.sessionId === null || typeof event.sessionId === 'string') &&
    (event.turnId === null || typeof event.turnId === 'string') &&
    typeof event.timestamp === 'number' && Number.isSafeInteger(event.timestamp) &&
    Math.abs(now - event.timestamp) <= MAX_EVENT_AGE_MS;
}

// Read a small JSON request while rejecting oversized or interrupted uploads.
async function readBody(request: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('Event exceeds size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

// Compare the bearer token without leaking a useful matching prefix.
function authenticated(request: IncomingMessage, token: string): boolean {
  const candidate = request.headers.authorization;
  if (typeof candidate !== 'string' || !candidate.startsWith('Bearer ')) return false;
  const actual = Buffer.from(candidate.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Accept one validated edit event and acknowledge it after the callback completes.
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  folders: readonly string[],
  onEdit: (event: EditEvent) => Promise<void>,
): Promise<void> {
  if (request.method !== 'POST' || request.url !== '/v1/events') {
    response.writeHead(404).end();
    return;
  }
  if (!authenticated(request, token)) {
    response.writeHead(401).end();
    return;
  }
  if (request.headers['content-type'] !== 'application/json') {
    response.writeHead(415).end();
    return;
  }
  try {
    const event = await readBody(request);
    if (!isEditEvent(event)) throw new Error('Invalid edit event');
    const resolved = await fs.realpath(event.path);
    const details = await fs.stat(resolved);
    if (!details.isFile() || !insideWorkspace(resolved, folders)) throw new Error('Out of scope');
    await onEdit({ ...event, path: resolved });
    response.writeHead(204).end();
  } catch {
    response.writeHead(400).end();
  }
}

// Start a window-local listener and publish its private descriptor for new terminals.
export async function startBridge(
  workspaceFolders: readonly string[],
  onEdit: (event: EditEvent) => Promise<void>,
): Promise<Bridge> {
  const folders = await Promise.all(workspaceFolders.map(folder => fs.realpath(folder)));
  const token = randomBytes(32).toString('hex');
  const server = createServer((request, response) => {
    void handleRequest(request, response, token, folders, onEdit);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No local listener port');
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'codex-auto-open-'));
    const descriptorPath = path.join(directory, DESCRIPTOR_NAME);
    try {
      await fs.writeFile(descriptorPath, JSON.stringify({
        version: 1, port: address.port, token, workspaceFolders: folders,
        processId: process.pid,
      }), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
    return {
      descriptorPath,
      close: async () => {
        await new Promise<void>(resolve => server.close(() => resolve()));
        await fs.rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server.close();
    throw error;
  }
}
