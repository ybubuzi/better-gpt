import { build } from 'esbuild';
import { lstat, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist');
if (dirname(output) !== root.replace(/[\\/]$/, '') || basename(output) !== 'dist') throw new Error('Invalid release output directory');
const existing = await lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; });
if (existing?.isSymbolicLink()) throw new Error('Release output must not be a link');

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const alias = {};
for (const directory of ['packages/contracts', 'packages/core', 'apps/tui']) {
  const workspace = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'));
  alias[workspace.name] = join(root, directory, 'dist', 'index.js');
  for (const [name, version] of Object.entries(workspace.dependencies ?? {})) {
    if (!name.startsWith('@better-gpt/') && manifest.dependencies?.[name] !== version) throw new Error(`Release dependency mismatch: ${name}`);
  }
}
const cli = JSON.parse(await readFile(join(root, 'apps/cli/package.json'), 'utf8'));
for (const [name, version] of Object.entries(cli.dependencies)) {
  if (!name.startsWith('@better-gpt/') && manifest.dependencies?.[name] !== version) throw new Error(`Release dependency mismatch: ${name}`);
}
if (manifest.version !== cli.version) throw new Error('Release and CLI versions differ');
await rm(output, { recursive: true, force: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: {
    index: 'apps/cli/dist/index.js',
    daemon: 'apps/cli/dist/daemon.js',
    'proxy-command': 'packages/core/dist/proxy-command.js',
    'grep-worker': 'packages/core/dist/grep-worker.js',
  },
  // Three directory levels preserve legacy-hive's package root lookup; helpers stay beside the entry points.
  outdir: join(output, 'apps/cli'),
  bundle: true, format: 'esm', platform: 'node', target: 'node24', packages: 'external', alias,
  splitting: false, sourcemap: false, metafile: true, logLevel: 'info',
});
for (const entry of Object.values(result.metafile.outputs)) {
  if (entry.imports.some(item => item.path.startsWith('@better-gpt/'))) throw new Error('Release still depends on an unpublished workspace');
}
console.log(`Standalone npm package ${manifest.name}@${manifest.version} ready.`);
