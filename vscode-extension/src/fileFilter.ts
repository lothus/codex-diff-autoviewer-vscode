import { promises as fs } from 'node:fs';
import path from 'node:path';
import { insideWorkspace } from './bridge';

const GENERATED_DIRECTORIES = new Set([
  '.git', '.venv', 'node_modules', 'out', 'dist', 'build', 'coverage', '.next', '.cache',
]);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.pdf', '.zip', '.gz',
  '.tar', '.7z', '.rar', '.mp3', '.mp4', '.mov', '.wav', '.ogg', '.woff', '.woff2', '.ttf',
  '.otf', '.eot', '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.pyc', '.wasm', '.sqlite',
]);

// Convert a workspace-relative glob to a regular expression.
export function globRegex(pattern: string): RegExp {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\/+/, '');
  let source = '^';
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index];
    if (character === '*' && normalized[index + 1] === '*') {
      index++;
      if (normalized[index + 1] === '/') {
        source += '(?:.*/)?';
        index++;
      } else {
        source += '.*';
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

// Match built-in generated directories and configured workspace-relative globs.
export function excluded(file: string, folders: readonly string[], patterns: readonly string[]): boolean {
  for (const folder of folders) {
    const relative = path.relative(folder, file);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const segments = relative.split(path.sep);
    if (segments.slice(0, -1).some(segment => GENERATED_DIRECTORIES.has(segment))) return true;
    const unixRelative = segments.join('/');
    if (patterns.some(pattern => {
      if (!pattern) return false;
      const target = pattern.replaceAll('\\', '/').includes('/') ? unixRelative : segments.at(-1)!;
      return globRegex(pattern).test(target);
    })) return true;
  }
  return false;
}

// Admit an accessible UTF-8 text file and reject common binary formats.
export async function readableTextFile(file: string): Promise<boolean> {
  if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) return false;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) return false;
    const sample = Buffer.alloc(Math.min(info.size, 4096));
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    if (sample.subarray(0, bytesRead).some(byte => byte < 9 || (byte > 13 && byte < 32) || byte === 127)) {
      return false;
    }
    new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, bytesRead), {
      stream: info.size > bytesRead,
    });
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Recheck scope and content immediately before a queued file is revealed.
export async function eligibleTextFile(
  file: string,
  folders: readonly string[],
  patterns: readonly string[],
): Promise<boolean> {
  try {
    const resolved = await fs.realpath(file);
    return insideWorkspace(resolved, folders) && !excluded(resolved, folders, patterns) &&
      readableTextFile(resolved);
  } catch {
    return false;
  }
}
