// The synthetic MCP programs `bun run test:integration` builds into a disposable directory before running the
// suites. Process suites call this before launching anything; it accepts only that launcher-owned directory.
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ProgramManifest } from '../../packages/mcp-programs/src/builder.ts';

export const MCP_FIXTURE_MARKER = 'agent-runtime-mcp-fixture';

export interface McpFixture {
  dir: string;
  manifest: ProgramManifest;
  program(id: string): { bundlePath: string; sha256: string };
}

export function requireMcpFixture(env: Record<string, string | undefined> = process.env): McpFixture {
  const dir = env.MCP_FIXTURE_PROGRAMS;
  if (
    dir === undefined ||
    !isAbsolute(dir) ||
    relative(resolve(tmpdir()), dir).startsWith('..') ||
    !existsSync(join(dir, MCP_FIXTURE_MARKER)) ||
    readFileSync(join(dir, MCP_FIXTURE_MARKER), 'utf8').trim() !== dir
  ) {
    throw new Error('MCP fixture programs missing: run process suites through `bun run test:integration`');
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ProgramManifest;
  return {
    dir,
    manifest,
    program(id) {
      const entry = manifest.programs.find((program) => program.id === id);
      if (entry === undefined) throw new Error(`fixture program ${id} was not built`);
      return { bundlePath: join(dir, entry.path), sha256: entry.sha256 };
    },
  };
}
