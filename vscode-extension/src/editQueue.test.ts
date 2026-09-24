import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditEvent } from './bridge';
import { EditQueue } from './editQueue';

// Build a valid edit event for one test turn.
function event(file: string, turnId: string | null = 'turn-1'): EditEvent {
  return { version: 1, path: file, operation: 'modify', sessionId: 'session-1',
    turnId, timestamp: Date.now() };
}

// Allow the queue timer and async drain to finish in these small unit tests.
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30));
}

// Verify deduplication, per-turn tab limits, and voluntary overflow opening.
test('limits each turn and exposes overflow through the command path', async () => {
  const opened: string[] = [];
  const notices: number[] = [];
  const queue = new EditQueue(
    () => ({ revealDelayMs: 0, dedupeMs: 1000, maxTabsPerTurn: 2 }),
    async () => true,
    async edit => { opened.push(edit.path); return true; },
    count => notices.push(count),
  );
  try {
    queue.submit(event('/a'));
    queue.submit(event('/a'));
    queue.submit(event('/b'));
    queue.submit(event('/c'));
    await settle();
    assert.deepEqual(opened, ['/a', '/b']);
    assert.deepEqual(queue.remainingFiles().map(edit => edit.path), ['/c']);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.deepEqual(notices, [1]);
    await queue.openRemaining('/c');
    assert.deepEqual(opened, ['/a', '/b', '/c']);
    queue.submit(event('/d', 'turn-2'));
    await settle();
    assert.deepEqual(opened, ['/a', '/b', '/c', '/d']);
  } finally {
    queue.dispose();
  }
  assert.deepEqual(notices, [1]);
});

// Verify filtered files and editor failures do not consume a turn's tab budget.
test('skips excluded files and isolates open failures', async () => {
  const opened: string[] = [];
  const queue = new EditQueue(
    () => ({ revealDelayMs: 0, dedupeMs: 0, maxTabsPerTurn: 1 }),
    async edit => edit.path !== '/excluded',
    async edit => {
      if (edit.path === '/broken') throw new Error('Editor closed');
      opened.push(edit.path);
      return true;
    },
    () => {},
  );
  try {
    for (const file of ['/excluded', '/broken', '/good', '/overflow']) queue.submit(event(file));
    await settle();
    assert.deepEqual(opened, ['/good']);
    assert.deepEqual(queue.remainingFiles().map(edit => edit.path), ['/overflow']);
  } finally {
    queue.dispose();
  }
});
