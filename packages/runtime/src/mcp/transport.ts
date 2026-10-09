// The only place an MCP server process is started (design Decisions 4–5). A server is a deployment-supplied,
// self-contained Bun bundle, verified against its configured SHA-256 and run by this runtime's own pinned Bun with
// installation, `.env` loading and project configuration disabled, from its own private directory, with a fixed
// argument vector (no shell) and an explicitly built environment: inherited process identity variables are
// overridden, and only approved literal settings and that server's own credential bindings are added. Nothing from
// this process's environment is forwarded. Standard error is discarded.
//
// This places the server's data; it does not sandbox it. A server remains trusted code with the operating-system
// access of the runtime user, including other writable runtime locations.
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isProtectedEnvironmentName } from '../config/capabilities.ts';
import type { ContentPolicy } from '../security/content-policy.ts';

export type { StdioServerParameters };

export const MCP_STATE_DIRECTORY = 'mcp';
/** Incoming bytes the SDK buffers before parsing a message (it may count several small ones in one chunk). */
export const MCP_MAX_MESSAGE_BYTES = 1_048_576;
export const PROGRAM_MAX_BYTES = 64 * 1_048_576;
/** Fixed, non-secret values for the variables the SDK would otherwise inherit from this process. */
export const FIXED_IDENTITY = Object.freeze({
  LOGNAME: 'agent-runtime-mcp',
  USER: 'agent-runtime-mcp',
  SHELL: '/bin/sh',
  TERM: 'dumb',
  PATH: '/usr/local/bin:/usr/bin:/bin',
});
/** Launch flags: never install packages, never read `.env`, never read a project or global bunfig. */
export const BUN_FLAGS = Object.freeze(['--config=/dev/null', '--no-install', '--no-env-file']);
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SERVER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface LaunchSpec {
  serverId: string;
  program: { bundlePath: string; sha256: string };
  /** Fixed arguments from the retained declaration. */
  args: readonly string[];
  /** Literal environment from the retained declaration. */
  declarationEnv: Readonly<Record<string, string>>;
  /** Literal environment the owner configured. */
  literalEnv: Readonly<Record<string, string>>;
  /** Credential values for the owner's slot bindings, already read from private storage. */
  credentialEnv: Readonly<Record<string, string>>;
}

export interface LaunchContext {
  stateDir: string;
  /** The pinned Bun executable; the runtime's own. */
  bunPath: string;
  /** Screens the declaration's arguments and literal values for known credentials before anything starts. */
  policy: ContentPolicy;
}

export type LaunchRefusal =
  | 'server_id_invalid'
  | 'environment_invalid'
  | 'environment_protected'
  | 'environment_conflict'
  | 'credential_in_declaration'
  | 'state_directory_unsafe'
  | 'program_missing'
  | 'program_unsafe'
  | 'program_digest_mismatch';

export type LaunchPlan = { ok: true; params: StdioServerParameters } | { ok: false; reason: LaunchRefusal };

const uid = () => process.getuid?.() ?? -1;
const isPrivate = (mode: number | bigint) => (Number(mode) & 0o077) === 0;

/** Creates (0700) or verifies an owner-only directory; anything else is refused, never repaired. */
async function privateDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && stat.uid === uid() && isPrivate(stat.mode);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') return false;
  }
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') return false;
  }
  const stat = await lstat(path).catch(() => undefined);
  return stat?.isDirectory() === true && stat.uid === uid() && isPrivate(stat.mode);
}

/** `<state>/mcp/<serverId>/{home,tmp}`: persistent across restarts and settlement, never deleted here. */
export async function prepareServerDirectories(
  stateDir: string,
  serverId: string,
): Promise<{ root: string; home: string; tmp: string } | undefined> {
  const base = join(stateDir, MCP_STATE_DIRECTORY);
  const root = join(base, serverId);
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  for (const directory of [base, root, home, tmp]) {
    if (!(await privateDirectory(directory))) return undefined;
  }
  return { root, home, tmp };
}

/** The bundle at its configured path is a regular file whose bytes have the configured digest. */
async function verifyProgram(program: LaunchSpec['program']): Promise<LaunchRefusal | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(program.bundlePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return (error as { code?: string }).code === 'ENOENT' ? 'program_missing' : 'program_unsafe';
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > PROGRAM_MAX_BYTES) return 'program_unsafe';
    const bytes = await handle.readFile();
    const digest = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    return digest === program.sha256 ? undefined : 'program_digest_mismatch';
  } finally {
    await handle.close();
  }
}

/**
 * The environment the server receives, built from nothing: fixed identity and private locations, then the
 * declaration's and owner's literals (which must agree where both set a name), then this server's credentials.
 */
export function serverEnvironment(
  spec: Pick<LaunchSpec, 'declarationEnv' | 'literalEnv' | 'credentialEnv'>,
  directories: { home: string; tmp: string },
): { ok: true; env: Record<string, string> } | { ok: false; reason: LaunchRefusal } {
  const all = [spec.declarationEnv, spec.literalEnv, spec.credentialEnv].flatMap((map) => Object.keys(map));
  if (all.some((name) => !ENVIRONMENT_NAME.test(name))) return { ok: false, reason: 'environment_invalid' };
  if (all.some(isProtectedEnvironmentName)) return { ok: false, reason: 'environment_protected' };
  const literals: Record<string, string> = { ...spec.declarationEnv };
  for (const [name, value] of Object.entries(spec.literalEnv)) {
    if (Object.hasOwn(literals, name) && literals[name] !== value) return { ok: false, reason: 'environment_conflict' };
    literals[name] = value;
  }
  if (Object.keys(spec.credentialEnv).some((name) => Object.hasOwn(literals, name))) {
    return { ok: false, reason: 'environment_conflict' };
  }
  return {
    ok: true,
    env: { ...FIXED_IDENTITY, HOME: directories.home, TMPDIR: directories.tmp, ...literals, ...spec.credentialEnv },
  };
}

/** Everything needed to start the server, or why it must not start. Nothing is launched here. */
export async function planLaunch(spec: LaunchSpec, context: LaunchContext): Promise<LaunchPlan> {
  if (!SERVER_ID.test(spec.serverId)) return { ok: false, reason: 'server_id_invalid' };
  const declared = [...spec.args, ...Object.values(spec.declarationEnv), ...Object.values(spec.literalEnv)];
  if (declared.some((value) => context.policy.detect(value) !== undefined)) {
    return { ok: false, reason: 'credential_in_declaration' };
  }
  const directories = await prepareServerDirectories(context.stateDir, spec.serverId);
  if (directories === undefined) return { ok: false, reason: 'state_directory_unsafe' };
  const environment = serverEnvironment(spec, directories);
  if (!environment.ok) return environment;
  const program = await verifyProgram(spec.program);
  if (program !== undefined) return { ok: false, reason: program };
  return {
    ok: true,
    params: {
      command: context.bunPath,
      args: [...BUN_FLAGS, spec.program.bundlePath, ...spec.args],
      env: environment.env,
      cwd: directories.root,
      stderr: 'ignore',
      maxBufferSize: MCP_MAX_MESSAGE_BYTES,
    },
  };
}

/**
 * The launch inputs a retained declaration contributes: its fixed arguments and literal environment. Only stdio
 * declarations are supported; HTTP (and with it OAuth) is visibly refused. The declaration's own `command` names the
 * program the facet expects, but what runs is the owner-bound program bundle, never that command.
 */
export function declarationLaunchInputs(
  declaration: Record<string, unknown>,
):
  | { ok: true; args: string[]; env: Record<string, string> }
  | { ok: false; reason: 'transport_unsupported' | 'declaration_invalid' } {
  if (declaration.type !== 'stdio') return { ok: false, reason: 'transport_unsupported' };
  const { args = [], env = {} } = declaration;
  if (
    !Array.isArray(args) ||
    args.length > 64 ||
    !args.every((arg) => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0'))
  ) {
    return { ok: false, reason: 'declaration_invalid' };
  }
  if (
    env === null ||
    typeof env !== 'object' ||
    Array.isArray(env) ||
    !Object.values(env).every((value) => typeof value === 'string' && value.length <= 4096 && !value.includes('\0'))
  ) {
    return { ok: false, reason: 'declaration_invalid' };
  }
  return { ok: true, args: [...(args as string[])], env: { ...(env as Record<string, string>) } };
}

/** A started transport and the moment its process has actually gone. */
export interface OwnedTransport {
  transport: StdioClientTransport;
  /** Resolves once the child process has exited and its streams closed. */
  exited: Promise<void>;
}

/**
 * The SDK stdio transport for a verified plan. The SDK spawns without a shell; its close() ends stdin, then sends
 * SIGTERM and SIGKILL after grace periods, and can return before the process is gone, so callers await `exited` too.
 */
export function ownedTransport(params: StdioServerParameters): OwnedTransport {
  const transport = new StdioClientTransport(params);
  let resolveExited: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  // The client protocol chains this handler when it connects, so it still runs on the process's close event.
  transport.onclose = () => resolveExited();
  // A process that never started has nothing to wait for.
  let started = false;
  const start = transport.start.bind(transport);
  const close = transport.close.bind(transport);
  transport.start = async () => {
    try {
      await start();
      started = true;
    } catch (error) {
      resolveExited();
      throw error;
    }
  };
  transport.close = async () => {
    await close();
    if (!started) resolveExited();
  };
  return { transport, exited };
}
