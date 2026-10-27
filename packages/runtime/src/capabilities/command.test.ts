import { describe, expect, test } from 'bun:test';
import { exactSecretMatcher } from '../credentials/matcher.ts';
import { canonicalJson } from '../records/canonical.ts';
import { createContentPolicy } from '../security/content-policy.ts';
import { OWNER_INPUT_HEADING, prepareCommandStart, renderCommand, selectionRevision } from './command.ts';
import { type Catalog, loadInstallation } from './installation.ts';
import type { CommandRunInput } from './records.ts';

const D = 'd'.repeat(64);
const SECRET = 'synthetic-command-argument-secret-01';
const policy = createContentPolicy(exactSecretMatcher([SECRET]));
const integrity = `sha256:${'f'.repeat(64)}`;
const origin = { facet: 'workflows', version: '1.0.0', source: 'local:./facets/workflows', integrity };

const command = (name: string, body: string, required: boolean, requires: unknown[] = []) => ({
  kind: 'command',
  facet: 'workflows',
  authoredName: name,
  materialization: { kind: 'authored' },
  files: [{ path: `commands/${name}.md`, integrity }],
  state: {
    kind: 'ready',
    definition: {
      id: `command:${name}`,
      name,
      description: `About ${name}`,
      origins: [origin],
      exportDigest: D,
      requires,
      body,
      arguments: { required },
    },
  },
});

function catalog(items: unknown[]): Catalog {
  const bytes = new TextEncoder().encode(
    `${canonicalJson({
      format: 2,
      profile: 1,
      toolchain: {
        cli: { version: '0.36.5', platform: 'linux-x64', sha256: 'c'.repeat(64) },
        adapter: { name: 'agent-runtime', apiVersion: '0.3', sdkVersion: '0.30.0', sha256: 'a'.repeat(64) },
      },
      inputs: { manifestVersion: 0.2, lockfileVersion: 0.4, manifestSha256: D, lockSha256: D },
      facets: [
        { facet: 'workflows', version: '1.0.0', source: { kind: 'local', path: './facets/workflows' }, integrity },
      ],
      items,
      servers: [],
      omittedServers: [],
    })}\n`,
  );
  const load = loadInstallation(bytes, new Bun.CryptoHasher('sha256').update(bytes).digest('hex'));
  if (load.kind !== 'ready') throw new Error(load.reason);
  return load.catalog;
}

const installed = catalog([
  command('triage', 'Triage $ARGUMENTS now. Then report on $ARGUMENTS.', true),
  command('summarize', 'Summarize the repository.', false),
  command('blocked', 'Blocked.', false, [{ kind: 'skill', id: 'skill:absent' }]),
]);
const start = (
  commandId: string,
  args: string,
  revision = selectionRevision(installed.installationSha256, commandId),
) =>
  prepareCommandStart(
    installed,
    {
      kind: 'command',
      commandId,
      selectionRevision: revision,
      arguments: args,
      provider: 'anthropic',
    } as CommandRunInput,
    policy,
  );

describe('command rendering', () => {
  test('replaces every literal marker with the raw argument text, keeping shell-like content inert', () => {
    for (const args of ['owner/repo-a', '$(rm -rf /) `id` $HOME $& $1 $$', '  spaced\nlines  ']) {
      expect(
        renderCommand({ body: 'Check $ARGUMENTS; again: $ARGUMENTS.', arguments: { required: true } }, args),
      ).toEqual({
        ok: true,
        goal: `Check ${args}; again: ${args}.`,
      });
    }
  });

  test('without the marker, non-blank arguments are appended in a labelled section and blank ones add nothing', () => {
    const body = { body: 'Summarize the repository.\n', arguments: { required: false } };
    expect(renderCommand(body, 'focus on docs')).toEqual({
      ok: true,
      goal: `Summarize the repository.\n\n${OWNER_INPUT_HEADING}\n\nfocus on docs`,
    });
    expect(renderCommand(body, '')).toEqual({ ok: true, goal: 'Summarize the repository.\n' });
    expect(renderCommand(body, '  \n')).toEqual({ ok: true, goal: 'Summarize the repository.\n' });
  });

  test('required arguments must be non-blank; blank, oversized or unstorable goals are refused, never truncated', () => {
    const required = { body: 'Do $ARGUMENTS', arguments: { required: true } };
    for (const args of ['', '   ', '\n\t'])
      expect(renderCommand(required, args)).toEqual({ ok: false, reason: 'arguments_required' });
    expect(renderCommand({ body: '$ARGUMENTS', arguments: { required: false } }, ' ')).toEqual({
      ok: false,
      reason: 'goal_blank',
    });
    expect(renderCommand(required, 'x'.repeat(8190))).toEqual({ ok: false, reason: 'goal_too_long' });
    expect(renderCommand(required, 'x'.repeat(8189))).toMatchObject({ ok: true });
    expect(renderCommand(required, 'a\u0000')).toEqual({ ok: false, reason: 'goal_not_storable' });
  });
});

describe('command start preparation', () => {
  test('renders the selected command under the currently offered revision', () => {
    const prepared = start('command:triage', 'owner/repo-a');
    expect(prepared).toMatchObject({ ok: true, goal: 'Triage owner/repo-a now. Then report on owner/repo-a.' });
    expect(prepared.ok && prepared.command.id).toBe('command:triage');
    expect(start('command:summarize', '')).toMatchObject({ ok: true, goal: 'Summarize the repository.' });
  });

  test('a revision differs per installation and per command', () => {
    expect(selectionRevision(D, 'command:triage')).not.toBe(selectionRevision('e'.repeat(64), 'command:triage'));
    expect(selectionRevision(D, 'command:triage')).not.toBe(selectionRevision(D, 'command:summarize'));
    expect(selectionRevision(D, 'command:triage')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('refuses secret-bearing arguments without echoing them, before anything else', () => {
    const refused = start('command:triage', `use ${SECRET}`, 'f'.repeat(64));
    expect(refused).toEqual({ ok: false, code: 'credential_in_input', reason: 'credential_in_input' });
    expect(JSON.stringify(refused)).not.toContain(SECRET);
  });

  test('a stale selection, a missing or refused command and bad arguments are refused, with no fallback', () => {
    expect(start('command:triage', 'x', selectionRevision('e'.repeat(64), 'command:triage'))).toEqual({
      ok: false,
      code: 'capability_selection_changed',
      reason: 'selection_changed',
      subject: 'command:triage',
    });
    expect(start('command:absent', 'x')).toMatchObject({
      ok: false,
      code: 'capability_unavailable',
      reason: 'command_missing',
    });
    expect(start('command:blocked', '')).toEqual({
      ok: false,
      code: 'capability_unavailable',
      reason: 'prerequisite_refused',
      subject: 'skill:absent',
    });
    expect(start('command:triage', '  ')).toEqual({
      ok: false,
      code: 'command_arguments_invalid',
      reason: 'arguments_required',
      subject: 'command:triage',
    });
    // A skill ID is not a command, whatever revision is offered for it.
    expect(start('skill:review', 'x')).toMatchObject({ ok: false, code: 'capability_unavailable' });
  });
});
