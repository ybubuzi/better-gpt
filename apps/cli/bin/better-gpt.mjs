#!/usr/bin/env node
import { access } from 'node:fs/promises';

const entry = new URL('../dist/index.js', import.meta.url);
try { await access(entry); }
catch { console.error('better-gpt 尚未编译，请在项目根目录运行 npm run build。'); process.exit(1); }
await import(entry.href);
