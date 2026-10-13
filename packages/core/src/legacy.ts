import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LegacyInventory } from '@better-gpt/contracts';
import { isMissing } from './config-store.js';
import { legacyDirectories } from './paths.js';

async function inspectPath(path: string) {
  try { return await stat(path); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}

export async function inspectLegacy(directory: string): Promise<LegacyInventory> {
  const exists = (await inspectPath(directory))?.isDirectory() ?? false;
  const files: LegacyInventory['files'] = [];
  for (const name of ['global_config.hive', 'workspaces.hive', 'skills.hive', 'downstream_mcps.hive', 'cloudflared.yml']) {
    const info = await inspectPath(join(directory, name));
    if (info?.isFile()) files.push({ name, bytes: info.size });
  }
  return {
    directory, exists, files, status: exists ? 'detected' : 'not-found',
    skillsDirectoryExists: (await inspectPath(join(directory, 'skills')))?.isDirectory() ?? false,
    cloudflareDirectoryExists: (await inspectPath(join(directory, 'cloudflare')))?.isDirectory() ?? false,
  };
}

export const discoverLegacy = (): Promise<LegacyInventory[]> => Promise.all(legacyDirectories().map(inspectLegacy));
