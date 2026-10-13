import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { terminalText } from '@better-gpt/core';

export const colors = { background: '#101216', sidebar: '#171a20', panel: '#11151b', border: '#343a46',
  active: '#313846', accent: '#aaa2ff', foreground: '#dde2eb', muted: '#929bac', success: '#42d392', danger: '#ff8088', warning: '#e9b96e' };
export const oneLine = (text: string): string => terminalText(text).replaceAll('\n', ' ');
export const wrappedLines = (text: string, width: number): string[] => wrapAnsi(terminalText(text), Math.max(1, width),
  { hard: true, trim: false }).split('\n');
export const bounded = (value: number, count: number): number => Math.max(0, Math.min(value, count - 1));
export function windowStart(index: number, length: number, visible: number): number {
  return Math.max(0, Math.min(index - Math.floor(visible / 2), length - visible));
}
export function elapsed(start: number, end: number): string {
  const seconds = Math.max(0, (end - start) / 1000);
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}
export const clock = (time: number): string => new Date(time).toLocaleTimeString('zh-CN', { hour12: false });

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <Box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center" paddingX={1}>
    <Text bold color={colors.foreground}>{title}</Text>
    <Box marginTop={1} flexDirection="column" alignItems="center">{children}</Box>
  </Box>;
}

export function TextViewport({ lines, height, offset, focus, title, follow = false }: {
  lines: string[]; height: number; offset: number; focus: boolean; title: string; follow?: boolean;
}) {
  const visible = Math.max(1, height - 2);
  const start = Math.max(0, Math.min(offset, lines.length - visible));
  return <Box flexDirection="column" height={height} paddingX={1} overflow="hidden">
    <Text color={focus ? colors.accent : colors.muted} wrap="truncate-end">{focus ? '▸ ' : '  '}{title}</Text>
    <Box flexDirection="column" height={visible} overflow="hidden">
      {lines.slice(start, start + visible).map((line, index) => <Text key={start + index} color={colors.foreground} wrap="truncate-end">{line || ' '}</Text>)}
    </Box>
    <Text color={colors.muted} wrap="truncate-end">{lines.length ? `${start + 1}–${Math.min(start + visible, lines.length)} / ${lines.length} 行` : '0 行'}  {follow ? '跟随输出' : 'PgUp/PgDn 翻页'}{focus ? ' · Home/End' : ''}</Text>
  </Box>;
}
