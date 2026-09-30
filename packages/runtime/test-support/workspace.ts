// Synthetic workspace trees for workspace-tool tests. Only temporary directories are used; nothing from the
// checkout, the host home directory or runtime state.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseOperatorConfig } from '../src/config/operator.ts';
import { createWorkspacePolicy, type FileIdentity, type WorkspacePolicy } from '../src/workspace/policy.ts';

export interface Fixture {
  base: string;
  root: string;
  outside: string;
  write(relative: string, contents: string | Uint8Array): string;
  policy(options?: { excludeNames?: string[]; excludePaths?: string[]; protect?: FileIdentity[] }): WorkspacePolicy;
  cleanup(): void;
}

export function createFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'agent-runtime-workspace-'));
  const root = join(base, 'workspace');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  return {
    base,
    root,
    outside,
    write(relative, contents) {
      const path = join(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
      return path;
    },
    policy(options = {}) {
      const config = parseOperatorConfig(
        JSON.stringify({
          version: 1,
          workspace: {
            id: 'fixture',
            label: 'Fixture',
            root,
            excludeNames: options.excludeNames ?? [],
            excludePaths: options.excludePaths ?? [],
          },
          providers: { anthropic: { authMode: 'subscription', model: 'm', profileId: 'p' } },
          defaultProvider: 'anthropic',
        }),
        { stateDir: join(base, 'state'), configFile: join(base, 'config.json') },
      );
      return createWorkspacePolicy(config.workspace, options.protect ?? []);
    },
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}
