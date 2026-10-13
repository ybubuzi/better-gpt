import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { appVersion, legacyToolSchemas, type LegacyToolName, type Workspace } from '@better-gpt/contracts';
import type { Application } from './application.js';

export const toolDescriptions: Record<LegacyToolName, string> = {
  read: 'Read one file with path, or several files with paths (max 20). Returns numbered lines. Read before changing code.',
  read_image: 'Read an image as MCP image content. Large images are resized and JPEG-compressed by default. Supports PNG, JPEG, GIF, WebP.',
  apply_patch: 'Apply validated file changes transactionally. Multiple edits to the same file compose in order; oldText replaces exactly one snippet, omit oldText to create/overwrite, delete=true deletes.',
  ls: 'List one directory without recursion.', grep: 'Search file contents by regex. Use include to narrow files.', glob: 'Find files by glob, including recursive ** and {a,b} alternatives.',
  code_explore: 'Outline source files under a directory and list their top-level declaration symbols.',
  exec_command: 'Run commands in this workspace. Return output and a session_id while still running.',
  write_stdin: 'Poll a command session or send stdin. Use \\u0003 to stop the command.',
  skills_list: 'List currently enabled skills for this workspace.', skill_read: 'Read the complete SKILL.md for one enabled skill.',
  mcp_tools: 'List enabled downstream MCP servers and cached tool definitions. Pass server for one server.',
  mcp_call: 'Call one tool on a downstream MCP allowed for this workspace. Only arguments is forwarded.',
  summary: 'Terminal tool for one user turn. If any tool from this MCP was used, call summary once, after all other tools and immediately before the final response. Use one short paragraph without lists or line breaks.',
};
const readOnly = new Set(['read', 'read_image', 'ls', 'grep', 'glob', 'code_explore', 'skills_list', 'skill_read', 'summary']);
export function annotations(name: string) { return { readOnlyHint: readOnly.has(name), destructiveHint: ['apply_patch', 'exec_command', 'write_stdin', 'mcp_call'].includes(name), openWorldHint: ['exec_command', 'mcp_call', 'mcp_tools'].includes(name) }; }

export function textResult(text: string, data: Record<string, unknown> = {}) {
  const rendered = text || '(empty)'; return { content: [{ type: 'text' as const, text: rendered }], structuredContent: { ...data, text: rendered } };
}
export function toolError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error); return { ...textResult(text, { error: text }), isError: true };
}

export async function serverInstructions(app: Application, workspace: Workspace): Promise<string> {
  const { config } = await app.store.read();
  const skills = config.skills.filter((skill) => skill.enabled && (workspace.selectedSkillNames === null || workspace.selectedSkillNames.includes(skill.name)));
  const mcps = config.downstreamMcps.filter((mcp) => mcp.enabled && (workspace.selectedMcpNames === null || workspace.selectedMcpNames.includes(mcp.name)));
  let instructions = `Workspace ${workspace.name}\nProject root: ${workspace.projectRoot}\nShell: ${process.platform === 'win32' ? 'powershell' : 'bash'}\nPaths are relative to the project root.\nUse read/grep/glob/code_explore before edits; apply_patch accepts JSON edits. Each tool needs a short user-visible purpose.\nOne round is one user message through one final response. Call summary exactly once after all other tool work, immediately before the final response.\n`;
  if (workspace.agentsMode === 'custom' && workspace.customAgents.trim()) instructions += `<project_instructions>\n${workspace.customAgents}\n</project_instructions>\n`;
  if (workspace.agentsMode === 'auto') for (const name of ['AGENTS.override.md', 'AGENTS.md']) try { const content = await readFile(join(workspace.projectRoot, name), 'utf8'); instructions += `<project_instructions>\n${content}\n</project_instructions>\n`; break; } catch {}
  instructions += `Skills (discover using skills_list): ${skills.map((skill) => `${skill.name}: ${skill.description}`).join('; ')}\nMCP servers (discover with mcp_tools, invoke with mcp_call): ${mcps.map((mcp) => mcp.name).join(', ')}`;
  return instructions;
}

export async function callLegacyTool(app: Application, uuid: string, name: LegacyToolName, raw: Record<string, unknown>) {
  if (name === 'exec_command' || name === 'write_stdin') {
    const parsed = legacyToolSchemas[name].parse(raw);
    const tokens = typeof parsed.max_output_tokens === 'number' && parsed.max_output_tokens > 0 ? Math.min(25_000, parsed.max_output_tokens) : 10_000;
    const common = { purpose: parsed.purpose, max_output_tokens: tokens, yield_time_ms: Math.min(30_000, Math.max(0, parsed.yield_time_ms)) };
    try {
      const result = name === 'exec_command' ? await app.executeCommand(uuid, { ...common, cmd: raw.cmd, workdir: raw.workdir ?? '.' })
        : await app.writeStdin(uuid, { ...common, session_id: raw.session_id, chars: raw.chars ?? '' });
      const text = result.output || (result.running ? '(running, no new output)' : '(command completed with no output)');
      return decorate(name, parsed.purpose, textResult(text, { running: result.running, output_truncated: result.output_truncated,
        ...(result.running || name === 'write_stdin' ? { session_id: result.session_id } : {}), ...(result.exit_code !== null ? { exit_code: result.exit_code } : {}),
        output: result.output, termination_requested: result.termination_requested }));
    } catch (error) { return decorate(name, parsed.purpose, toolError(app.runtime.redact(error instanceof Error ? error.message : String(error)))); }
  }
  return app.runtime.trace(uuid, name, raw, async () => {
    const purpose = String(raw.purpose ?? name);
    try {
      const workspace = await app.workspace(uuid), files = await app.files(uuid);
      let result;
      switch (name) {
        case 'read': { const value = await files.read(legacyToolSchemas.read.parse(raw)); result = textResult(value.text, value); break; }
        case 'ls': { const value = await files.ls(legacyToolSchemas.ls.parse(raw).path); result = textResult(value.text, value); break; }
        case 'read_image': result = await files.image(legacyToolSchemas.read_image.parse(raw)); break;
        case 'apply_patch': { const value = await files.patch(legacyToolSchemas.apply_patch.parse(raw).edits); result = textResult(value.text, value); break; }
        case 'grep': { const value = await files.grep(legacyToolSchemas.grep.parse(raw)); result = textResult(value.text, value); break; }
        case 'glob': { const value = await files.glob(legacyToolSchemas.glob.parse(raw)); result = textResult(value.text, value); break; }
        case 'code_explore': { const value = await files.explore(legacyToolSchemas.code_explore.parse(raw)); result = textResult(value.text, value); break; }
        case 'skills_list': case 'skill_read': {
          const { config } = await app.store.read();
          const skills = config.skills.filter((skill) => skill.enabled && (workspace.selectedSkillNames === null || workspace.selectedSkillNames.includes(skill.name)));
          const metadata = (skill: typeof skills[number]) => ({ name: skill.name, description: skill.description, source: skill.source, ...(skill.rootPath ? { rootPath: skill.rootPath } : {}) });
          if (name === 'skills_list') { result = textResult(skills.length ? skills.map((skill) => `- ${skill.name}: ${skill.description}\n`).join('') : 'No skills enabled.', { count: skills.length, skills: skills.map(metadata) }); break; }
          const requested = legacyToolSchemas.skill_read.parse(raw).name, skill = skills.find((entry) => entry.name === requested); if (!skill) throw new Error(`Unknown skill: ${requested}`);
          let content: string | undefined;
          if (skill.rootPath) for (const candidate of [skill.rootPath, join(skill.rootPath, 'SKILL.md')]) try { if ((await stat(candidate)).isFile()) { content = await readFile(candidate, 'utf8'); break; } } catch {}
          result = textResult(content ?? `${skill.name}: ${skill.description}`, metadata(skill)); break;
        }
        case 'mcp_tools': { const value = await app.downstream.list(workspace, legacyToolSchemas.mcp_tools.parse(raw).server); result = textResult(value.text, value); break; }
        case 'mcp_call': {
          const args = legacyToolSchemas.mcp_call.parse(raw), value = await app.downstream.call(workspace, args.server, args.tool, args.arguments);
          const blocks = value.content, text = blocks.map((block) => block.type === 'text' ? block.text : block.type === 'image' ? `[image: ${block.mimeType}]` : JSON.stringify(block)).join('\n');
          const structured = value.structuredContent && typeof value.structuredContent === 'object' && !Array.isArray(value.structuredContent) ? value.structuredContent : {};
          const isError = 'isError' in value && value.isError === true;
          result = blocks.some((block) => block.type !== 'text') ? { content: blocks, structuredContent: { ...structured, text }, ...(isError ? { isError: true } : {}) }
            : { ...textResult(text, value as unknown as Record<string, unknown>), ...(isError ? { isError: true } : {}) }; break;
        }
        case 'summary': {
          const args = legacyToolSchemas.summary.parse(raw), summary = args.summary.replace(/\s+/g, ' ').trim(), endedAt = new Date().toISOString();
          app.runtime.summary = { workspaceId: uuid, title: args.title, text: summary, endedAt }; app.runtime.changed();
          result = textResult(summary, { title: args.title, summary, endedAt, workspace: workspace.name, fileChanges: files.takeChanges() }); break;
        }
      }
      return decorate(name, purpose, result);
    } catch (error) { return decorate(name, purpose, toolError(app.runtime.redact(error instanceof Error ? error.message : String(error)))); }
  });
}

function decorate<T extends { content: unknown[]; structuredContent: unknown; isError?: boolean }>(name: string, purpose: string, result: T) {
  return { ...result, _meta: { codexMcpUi: { tool: name, title: name, purpose, ok: !result.isError, annotations: annotations(name) },
    ...(name === 'summary' ? { ui: { resourceUri: 'ui://codexter/round-summary-ui.html', visibility: ['model', 'app'] }, 'openai/outputTemplate': 'ui://codexter/round-summary-ui.html' } : {}) } };
}

export const workspaceOverview = (workspace: Workspace) => ({ uuid: workspace.uuid, name: workspace.name, projectRoot: workspace.projectRoot, version: appVersion });
