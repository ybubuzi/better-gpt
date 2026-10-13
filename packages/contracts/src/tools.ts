import { z } from 'zod';

const purpose = z.string().min(1).max(80);
const text = z.string();
const integer = z.coerce.number().int();
const input = <T extends z.ZodRawShape>(shape: T) => z.object({ ...shape, purpose }).passthrough();

export const legacyToolSchemas = {
  read: input({ path: text.optional(), paths: z.array(text).optional(), offset: integer.default(1), limit: integer.optional() }),
  read_image: input({ path: text.min(1), process: z.enum(['auto', 'none']).default('auto'),
    max_long_edge: integer.min(256).max(4096).default(2048), quality: integer.min(40).max(95).default(82) }),
  apply_patch: input({ edits: z.array(z.object({ path: text.min(1), oldText: text.optional(), newText: text.optional(), delete: z.boolean().optional() }).passthrough()).min(1).max(200) }),
  ls: input({ path: text.default('.') }),
  grep: input({ pattern: text.min(1), path: text.default('.'), include: text.optional(), maxResults: integer.default(100), caseSensitive: z.boolean().default(true) }),
  glob: input({ pattern: text.min(1), path: text.default('.'), maxResults: integer.default(500) }),
  code_explore: input({ path: text.default('.'), maxFiles: integer.default(80) }),
  exec_command: input({ cmd: text.min(1), workdir: text.default('.'), yield_time_ms: integer.default(10_000), max_output_tokens: integer.optional() }),
  write_stdin: input({ session_id: integer, chars: text.default(''), yield_time_ms: integer.default(5000), max_output_tokens: integer.optional() }),
  skills_list: input({}),
  skill_read: input({ name: text.min(1) }),
  mcp_tools: input({ server: text.optional() }),
  mcp_call: input({ server: text.min(1), tool: text.min(1), arguments: z.record(text, z.unknown()).default({}) }),
  summary: input({ title: text.max(80).default('本轮处理结束'), summary: text.max(600).min(1) }),
};
export type LegacyToolName = keyof typeof legacyToolSchemas;
