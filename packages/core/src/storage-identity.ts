import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertNoDestinationLinks } from './destination-guard.js';

/** An actual write is essential: MSIX may merge directory reads while redirecting individual file writes. */
export async function storageIdentityPath(directory: string): Promise<string> {
  const marker = join(directory, 'runtime', 'control.identity');
  await assertNoDestinationLinks(directory, marker);
  await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
  await writeFile(marker, 'better-gpt-control-identity-v2\n', { mode: 0o600 });
  return realpath(marker);
}
