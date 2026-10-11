import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isMainEntrypoint } from '../apps/api/src/server.js';

describe('backtester entrypoint through current symlink', () => {
  it('recognizes the real module when argv points through a directory symlink', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'pine-server-main-'));
    try {
      const release = path.join(temporaryRoot, 'release');
      const current = path.join(temporaryRoot, 'current');
      await mkdir(release);
      await writeFile(path.join(release, 'server.js'), '');
      await symlink(release, current, 'junction');

      const linkedEntrypoint = path.join(current, 'server.js');
      const resolvedUrl = pathToFileURL(realpathSync(linkedEntrypoint)).href;
      expect(isMainEntrypoint(resolvedUrl, linkedEntrypoint)).toBe(true);
      expect(isMainEntrypoint(resolvedUrl, undefined)).toBe(false);
      expect(isMainEntrypoint(pathToFileURL(path.join(release, 'other.js')).href, linkedEntrypoint)).toBe(false);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
