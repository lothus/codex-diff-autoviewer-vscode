import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { eligibleTextFile, excluded, globRegex, readableTextFile } from './fileFilter';

// Check that workspace-relative globs match paths without crossing boundaries.
test('matches configured exclusions and generated directories', () => {
  const root = path.resolve('/workspace');
  assert.equal(globRegex('**/*.log').test('one/two/output.log'), true);
  assert.equal(globRegex('src/*.ts').test('src/nested/file.ts'), false);
  assert.equal(excluded(path.join(root, 'src', 'generated.ts'), [root], ['src/*.ts']), true);
  assert.equal(excluded(path.join(root, 'node_modules', 'pkg', 'file.js'), [root], []), true);
  assert.equal(excluded(path.join(root, 'src', 'file.ts'), [root], ['*.log']), false);
  assert.equal(excluded(path.join(root, 'src', 'file.ts'), [root], ['**/src/**']), true);
  assert.equal(excluded(path.join(root, 'src', 'file.ts'), [root], ['src\\*.ts']), true);
});

// Check that text remains eligible while binary and inaccessible files are skipped.
test('screens text, binary, and missing files', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'codex-filter-test-'));
  try {
    const textFile = path.join(directory, 'good.ts');
    const binaryFile = path.join(directory, 'binary.dat');
    const imageFile = path.join(directory, 'image.png');
    await fs.writeFile(textFile, 'export const café = true;');
    await fs.writeFile(binaryFile, Buffer.from([1, 0, 2]));
    await fs.writeFile(imageFile, 'looks like text');
    assert.equal(await readableTextFile(textFile), true);
    assert.equal(await readableTextFile(binaryFile), false);
    assert.equal(await readableTextFile(imageFile), false);
    assert.equal(await readableTextFile(path.join(directory, 'gone.ts')), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// Verify queued paths are checked again if they become symlinks outside the workspace.
test('rejects an escaping symlink at reveal time', async () => {
  if (process.platform === 'win32') return;
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'codex-scope-test-'));
  try {
    const workspace = path.join(directory, 'workspace');
    await fs.mkdir(workspace);
    const outside = path.join(directory, 'outside.ts');
    const link = path.join(workspace, 'linked.ts');
    await fs.writeFile(outside, 'secret');
    await fs.symlink(outside, link);
    assert.equal(await eligibleTextFile(link, [workspace], []), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
