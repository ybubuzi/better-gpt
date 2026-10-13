import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, basename, dirname, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { diffLines } from 'diff';
import { Worker } from 'node:worker_threads';

export interface FileChange { path: string; status: string; additions: number; deletions: number }
interface TrackedFile { path: string; before: string | null; after: string | null }
const normalize = (value: string) => value.replace(/\r\n|\r/g, '\n');
const linesOf = (value: string) => { const lines = value.split(/\r\n|\r|\n/); if (lines.at(-1) === '') lines.pop(); return lines; };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const skipDirs = new Set(['.git', 'node_modules', '.dart_tool', 'build', 'dist', 'out', '.next', '.venv', 'venv', '__pycache__', 'target', '.idea', '.gradle', 'Pods']);
const sourceExtensions = new Set('dart ts tsx js jsx py go rs java kt swift c h cc cpp hpp cs rb php vue svelte sql sh'.split(' '));

export class WorkspaceFiles {
  private changes = new Map<string, TrackedFile>();
  private writing: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) {}
  private check(root: string, path: string): void {
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path escapes project root: ${path}`);
  }
  async safePath(input: string): Promise<string> {
    const root = await realpath(this.root), path = resolve(root, input);
    this.check(root, path);
    let existing = path;
    while (true) {
      try { this.check(root, await realpath(existing)); break; }
      catch (error) { if (!missing(error)) throw error; const parent = dirname(existing); if (parent === existing) throw error; existing = parent; }
    }
    return path;
  }
  async read(args: { path?: string | undefined; paths?: string[] | undefined; offset: number; limit?: number | undefined }) {
    const targets = [...(args.path ? [args.path] : []), ...(args.paths ?? [])].filter(Boolean);
    const unique = [...new Set(targets)].slice(0, 20);
    if (!unique.length) throw new Error('path or paths is required');
    const results: Record<string, unknown>[] = []; let text = '';
    for (const path of unique) {
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(await this.safePath(path))); }
      catch (error) { if (!missing(error)) throw error; results.push({ path, found: false }); if (unique.length > 1) text += `=== ${path} (not found) ===\n`; continue; }
      const lines = linesOf(content), offset = Math.min(lines.length, Math.max(0, args.offset - 1));
      const slice = lines.slice(offset, offset + Math.min(2000, Math.max(1, args.limit ?? (unique.length === 1 ? 2000 : 400))));
      if (unique.length > 1) text += `=== ${path} ===\n`;
      text += slice.map((line, index) => `${offset + index + 1}| ${line}\n`).join('');
      if (unique.length > 1) text += '\n';
      results.push({ path, found: true, offset: offset + 1, lineCount: slice.length, totalLines: lines.length });
    }
    return { text, files: results, truncated: targets.length > 20 };
  }
  async ls(path: string) {
    const directory = await this.safePath(path);
    const entries = await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => {
      const info = await lstat(join(directory, entry.name));
      return { name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', ...(!entry.isDirectory() ? { size: info.size } : {}) };
    }));
    entries.sort((a, b) => (a.type === b.type ? 0 : a.type === 'directory' ? -1 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { path, count: entries.length, entries, text: entries.map((entry) => `${entry.type === 'directory' ? '[dir] ' : '      '}${entry.name}\n`).join('') };
  }
  async image(args: { path: string; process: 'auto' | 'none'; max_long_edge: number; quality: number }) {
    const path = await this.safePath(args.path), info = await stat(path);
    if (info.size > 20 * 1024 * 1024) throw new Error('Image exceeds 20 MiB source limit');
    const mimeTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    const originalMime = mimeTypes[extname(path).toLowerCase()]; if (!originalMime) throw new Error('Unsupported image format; use PNG, JPEG, GIF or WebP');
    const original = await readFile(path), metadata = await sharp(original, { limitInputPixels: 50_000_000 }).metadata();
    const width = metadata.width ?? 0, height = metadata.height ?? 0;
    if (!width || !height || width * height > 50_000_000) throw new Error('Image dimensions exceed limit');
    let output = original, mimeType = originalMime, processed = false, outputWidth = width, outputHeight = height, quality = args.quality;
    if (args.process === 'auto' && (original.length > 1024 * 1024 || Math.max(width, height) > args.max_long_edge)) {
      processed = true; mimeType = 'image/jpeg'; let longEdge = Math.min(Math.max(width, height), args.max_long_edge);
      const encode = async () => sharp(original, { limitInputPixels: 50_000_000 }).resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer({ resolveWithObject: true });
      let encoded = await encode();
      for (const candidate of [75, 68, 60]) if (encoded.data.length > 1536 * 1024 && candidate < quality) { quality = candidate; encoded = await encode(); }
      while (encoded.data.length > 1536 * 1024 && longEdge > 640) { longEdge = Math.max(640, Math.round(longEdge * 0.85)); encoded = await encode(); }
      output = encoded.data; outputWidth = encoded.info.width; outputHeight = encoded.info.height;
    }
    if (output.length > 3 * 1024 * 1024) throw new Error('Image output exceeds 3 MiB; use process=auto');
    return { content: [{ type: 'image' as const, data: output.toString('base64'), mimeType }], structuredContent: {
      path: args.path, mimeType, size: output.length, originalSize: original.length, originalWidth: width, originalHeight: height,
      width: outputWidth, height: outputHeight, processed, ...(processed ? { quality } : {}),
    } };
  }
  async walk(path: string, maxFiles: number, accept: (path: string) => boolean = () => true): Promise<{ path: string; absolute: string; size: number }[]> {
    const root = await realpath(this.root), directory = await this.safePath(path), files: { path: string; absolute: string; size: number }[] = [];
    const walk = async (folder: string): Promise<void> => {
      let entries; try { entries = await readdir(folder, { withFileTypes: true }); } catch (error) { if (missing(error)) return; throw error; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const absolute = join(folder, entry.name), rel = relative(root, absolute).split(sep).join('/');
        if (rel.split('/').some((segment) => skipDirs.has(segment))) continue;
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile() && accept(rel)) { const info = await stat(absolute); files.push({ path: rel, absolute, size: info.size }); }
        if (files.length >= Math.max(1, maxFiles)) return;
      }
    };
    await walk(directory); return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  private async textLines(file: { absolute: string; size: number }): Promise<string[]> {
    if (file.size > 2 * 1024 * 1024) return [];
    try { return linesOf(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file.absolute))); } catch { return []; }
  }
  async glob(args: { path: string; pattern: string; maxResults: number }) {
    const match = globRegex(args.pattern); const files = (await this.walk(args.path, Math.min(20_000, args.maxResults), (path) => match.test(path))).map((file) => file.path);
    return { text: files.join('\n'), count: files.length, files };
  }
  async grep(args: { path: string; pattern: string; include?: string | undefined; maxResults: number; caseSensitive: boolean }) {
    new RegExp(args.pattern, args.caseSensitive ? '' : 'i');
    const include = args.include ? globRegex(args.include) : undefined;
    const worker = new Worker(new URL('./grep-worker.js', import.meta.url), { workerData: { pattern: args.pattern, caseSensitive: args.caseSensitive }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64 } });
    const matches: { path: string; line: number; text: string }[] = [], max = Math.min(10_000, Math.max(1, args.maxResults));
    try { for (const file of await this.walk(args.path, 20_000, (path) => !include || include.test(path))) {
      const lines = await this.textLines(file);
      if (!lines.length) continue;
      const found = await new Promise<{ line: number; text: string }[]>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); worker.off('message', done); worker.off('error', failed); };
        const done = (result: { line: number; text: string }[]) => { cleanup(); resolve(result); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const timer = setTimeout(() => { cleanup(); reject(new Error('Regex processing exceeded 2 seconds')); void worker.terminate(); }, 2000);
        worker.once('message', done); worker.once('error', failed); worker.postMessage({ lines, limit: max - matches.length });
      });
      matches.push(...found.map((match) => ({ path: file.path, ...match })));
      if (matches.length >= max) break;
    } } finally { await worker.terminate(); }
    return { text: matches.map((match) => `${match.path}:${match.line}: ${match.text}\n`).join(''), matches, matchCount: matches.length, truncated: matches.length >= max };
  }
  async explore(args: { path: string; maxFiles: number }) {
    const symbols = /^\s*(?:export\s+)?(?:abstract\s+|final\s+|sealed\s+|static\s+|async\s+)*(class|mixin|enum|extension|typedef|interface|struct|func|function|def|fn)\s+([A-Za-z_]\w*)/;
    const outline = [];
    for (const file of await this.walk(args.path, Math.min(500, Math.max(1, args.maxFiles)), (path) => sourceExtensions.has(extname(path).slice(1).toLowerCase()))) {
      const lines = await this.textLines(file), found: string[] = [];
      for (let index = 0; index < lines.length && found.length < 12; index++) { const match = symbols.exec(lines[index]!); if (match) found.push(`${match[1]} ${match[2]} (L${index + 1})`); }
      outline.push({ path: file.path, lines: lines.length, symbols: found });
    }
    return { root: args.path, fileCount: outline.length, outline, text: outline.map((file) => `${file.path}  ·  ${file.lines} lines\n${file.symbols.map((symbol) => `    ${symbol}\n`).join('')}`).join('') };
  }
  patch(edits: { path: string; oldText?: string | undefined; newText?: string | undefined; delete?: boolean | undefined }[]) {
    const operation = this.writing.then(() => this.commitPatch(edits)); this.writing = operation.catch(() => {}); return operation;
  }
  private async commitPatch(edits: { path: string; oldText?: string | undefined; newText?: string | undefined; delete?: boolean | undefined }[]) {
    const plans = new Map<string, { path: string; absolute: string; before: Buffer | null; mode: number; after: string | null }>();
    for (const edit of edits) {
      const absolute = await this.safePath(edit.path), key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
      let plan = plans.get(key);
      if (!plan) { let before: Buffer | null = null, mode = 0o600; try { before = await readFile(absolute); mode = (await stat(absolute)).mode; } catch (error) { if (!missing(error)) throw error; }
        plan = { path: edit.path, absolute, before, mode, after: before === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(before) }; plans.set(key, plan); }
      if (edit.delete) { if (plan.after === null) throw new Error(`File not found: ${edit.path} (nothing was written)`); plan.after = null; }
      else if (edit.oldText === undefined) plan.after = edit.newText ?? '';
      else {
        if (!edit.oldText || plan.after === null) throw new Error(`oldText must be nonempty and file must exist: ${edit.path}`);
        const old = normalize(edit.oldText), content = normalize(plan.after);
        const index = content.indexOf(old); if (index < 0 || content.indexOf(old, index + old.length) >= 0) throw new Error(`oldText must match exactly once in ${edit.path} (nothing was written)`);
        const updated = content.slice(0, index) + normalize(edit.newText ?? '') + content.slice(index + old.length);
        plan.after = plan.after.includes('\r\n') ? updated.replaceAll('\n', '\r\n') : updated;
      }
    }
    const committed: typeof plans extends Map<string, infer T> ? T[] : never = [];
    try {
      for (const plan of plans.values()) {
        await this.safePath(plan.path);
        let current: Buffer | null; try { current = await readFile(plan.absolute); } catch (error) { if (!missing(error)) throw error; current = null; }
        if (current === null ? plan.before !== null : !plan.before?.equals(current)) throw new Error(`File changed concurrently: ${plan.path}`);
      }
      for (const plan of plans.values()) {
        const check = async () => {
          await this.safePath(plan.path);
          const current = await readFile(plan.absolute).catch((error: unknown) => { if (!missing(error)) throw error; return null; });
          if (current === null ? plan.before !== null : !plan.before?.equals(current)) throw new Error(`File changed concurrently: ${plan.path}`);
        };
        if (plan.after === null) { await check(); if (plan.before === null) continue; await unlink(plan.absolute); committed.push(plan); }
        else { await mkdir(dirname(plan.absolute), { recursive: true }); const temporary = join(dirname(plan.absolute), `.${basename(plan.absolute)}.${randomUUID()}.tmp`); try { await writeFile(temporary, plan.after, { flag: 'wx', mode: plan.mode }); await check(); await rename(temporary, plan.absolute); committed.push(plan); } finally { await rm(temporary, { force: true }); }
          if (!(await readFile(plan.absolute)).equals(Buffer.from(plan.after))) throw new Error(`Write verification failed: ${plan.path}`); }
      }
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const plan of committed.reverse()) try {
        await this.safePath(plan.path);
        const current = await readFile(plan.absolute).catch((error: unknown) => { if (!missing(error)) throw error; return null; });
        if (current === null ? plan.after !== null : plan.after === null || !current.equals(Buffer.from(plan.after))) {
          rollbackErrors.push(`${plan.path} (external edit preserved)`); continue;
        }
        if (plan.before === null) await rm(plan.absolute, { force: true }); else await writeFile(plan.absolute, plan.before, { mode: plan.mode });
      } catch { rollbackErrors.push(plan.path); }
      throw new Error(`apply_patch commit failed: ${error instanceof Error ? error.message : error}${rollbackErrors.length ? `; rollback failed: ${rollbackErrors.join(', ')}` : ''}`);
    }
    for (const [key, plan] of plans) { const previous = this.changes.get(key); this.changes.set(key, { path: plan.path.replaceAll('\\', '/'), before: previous ? previous.before : (plan.before?.toString('utf8') ?? null), after: plan.after }); }
    const files = [...plans.values()].map((plan) => plan.path); return { files, deleted: [...plans.values()].filter((plan) => plan.after === null).map((plan) => plan.path), text: `Applied ${edits.length} edit(s) across ${files.length} file(s): ${files.join(', ')}` };
  }
  takeChanges() {
    const files: FileChange[] = [];
    for (const change of this.changes.values()) {
      if (change.before !== null && change.after !== null && normalize(change.before) === normalize(change.after)) continue;
      if (change.before === null && change.after === null) continue;
      const before = normalize(change.before ?? ''), after = normalize(change.after ?? '');
      const parts = diffLines(before, after, { timeout: 150 }) ?? [{ value: before, removed: true, count: linesOf(before).length }, { value: after, added: true, count: linesOf(after).length }];
      files.push({ path: change.path, status: change.before === null ? 'added' : change.after === null ? 'deleted' : 'modified', additions: parts.filter((part) => part.added).reduce((sum, part) => sum + (part.count ?? 0), 0), deletions: parts.filter((part) => part.removed).reduce((sum, part) => sum + (part.count ?? 0), 0) });
    }
    this.changes.clear(); files.sort((a, b) => a.path.localeCompare(b.path));
    return { count: files.length, additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0), files };
  }
}

export function globRegex(value: string): RegExp {
  let pattern = value.replaceAll('\\', '/').trim() || '**'; if (!pattern.includes('/') && !pattern.startsWith('**')) pattern = `**/${pattern}`;
  const translate = (pattern: string): string => {
    let out = '';
    for (let index = 0; index < pattern.length; index++) {
      const char = pattern[index]!;
      if (char === '*') { if (pattern[index + 1] === '*') { if (pattern[index + 2] === '/') { out += '(?:.*/)?'; index += 2; } else { out += '.*'; index++; } } else out += '[^/]*'; }
      else if (char === '?') out += '[^/]';
      else if (char === '{' && pattern.indexOf('}', index) > index) { const end = pattern.indexOf('}', index); out += `(?:${pattern.slice(index + 1, end).split(',').map(translate).join('|')})`; index = end; }
      else out += /[.+^$()[\]|\\]/.test(char) ? `\\${char}` : char;
    }
    return out;
  };
  return new RegExp(`^${translate(pattern)}$`, 'i');
}
