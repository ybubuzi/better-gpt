import { resolve } from 'node:path';
import { dataDirectory, runDaemon } from '@better-gpt/core';
const index = process.argv.indexOf('--data-dir');
const directory = index >= 0 && process.argv[index + 1] ? resolve(process.argv[index + 1]!) : dataDirectory();
try { await runDaemon(directory); }
catch (error) { process.stderr.write((error instanceof Error ? error.message : '后台服务启动失败') + '\n'); process.exitCode = 1; }
