import { parentPort, workerData } from 'node:worker_threads';
const options = workerData as { pattern: string; caseSensitive: boolean };
const regex = new RegExp(options.pattern, options.caseSensitive ? '' : 'i');
parentPort!.on('message', (request: { lines: string[]; limit: number }) => {
  const matches: { line: number; text: string }[] = [];
  for (let index = 0; index < request.lines.length; index++) if (regex.test(request.lines[index]!)) {
    const text = request.lines[index]!; matches.push({ line: index + 1, text: text.length > 240 ? `${text.slice(0, 240)}…` : text }); if (matches.length >= request.limit) break;
  }
  parentPort!.postMessage(matches);
});
