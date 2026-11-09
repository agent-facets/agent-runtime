// Docker access for the live deployment, through an injectable command runner so every sequence can be tested
// without Docker. Inspection output is parsed here and never printed: container environments hold secrets.
import { join } from 'node:path';
import { repoRoot } from '../workspace.ts';
import { PROJECT, type Service } from './args.ts';
import { IMAGE_ID } from './state.ts';

export interface RunOptions {
  /** Capture output instead of passing it through to this terminal. */
  capture?: boolean;
  /** Connect this process's standard input (for interactive and secret-reading commands). */
  stdin?: boolean;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (argv: string[], options?: RunOptions) => Promise<RunResult>;

/** Variables a Docker client may need. Anything else, including COMPOSE_* and AGENT_RUNTIME_*, is not passed on. */
const PASSED_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'NO_COLOR',
];

export function childEnv(
  ambient: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_ENV) {
    const value = ambient[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

export function processRunner(ambient: Record<string, string | undefined>): Runner {
  return async (argv, options = {}) => {
    const child = Bun.spawn(argv, {
      cwd: repoRoot,
      env: options.env ?? childEnv(ambient),
      stdin: options.stdin ? 'inherit' : 'ignore',
      stdout: options.capture ? 'pipe' : 'inherit',
      stderr: options.capture ? 'pipe' : 'inherit',
    });
    const timer =
      options.timeoutMs === undefined ? undefined : setTimeout(() => child.kill('SIGKILL'), options.timeoutMs);
    try {
      const [stdout, stderr] = options.capture
        ? await Promise.all([
            new Response(child.stdout as ReadableStream).text(),
            new Response(child.stderr as ReadableStream).text(),
          ])
        : ['', ''];
      return { code: await child.exited, stdout, stderr };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/** The tag a selected image is given so Compose can name it; Compose does not accept a bare image ID. */
export function deployTag(imageId: string): string {
  if (!IMAGE_ID.test(imageId)) throw new Error(`not an image ID: ${imageId}`);
  return `agent-runtime/runtime:live-${imageId.slice('sha256:'.length)}`;
}

export const COMPOSE_FILE = join(repoRoot, 'compose.yaml');

export function composeArgs(envFile: string): string[] {
  return [
    'docker',
    'compose',
    '-p',
    PROJECT,
    '--project-directory',
    repoRoot,
    '--env-file',
    envFile,
    '-f',
    COMPOSE_FILE,
  ];
}

export interface Container {
  id: string;
  service: Service;
  status: string;
  health?: string;
  imageId: string;
  networkMode: string;
  labels: Record<string, string>;
  mounts: { type: string; name?: string; source: string; destination: string }[];
}

interface InspectedContainer {
  Id: string;
  Image: string;
  State: { Status: string; Health?: { Status: string } };
  HostConfig: { NetworkMode: string };
  Config: { Labels: Record<string, string> | null };
  Mounts: { Type: string; Name?: string; Source: string; Destination: string }[] | null;
}

export class DockerError extends Error {
  override readonly name = 'DockerError';
}

export class Docker {
  constructor(
    private readonly runner: Runner,
    private readonly ambient: Record<string, string | undefined>,
  ) {}

  env(extra: Record<string, string> = {}) {
    return childEnv(this.ambient, extra);
  }

  async capture(argv: string[], timeoutMs?: number): Promise<RunResult> {
    return this.runner(argv, { capture: true, env: this.env(), timeoutMs });
  }

  /** The deployment's containers by service; services without a container are absent. */
  async containers(): Promise<Partial<Record<Service, Container>>> {
    const listed = await this.capture([
      'docker',
      'ps',
      '-aq',
      '--filter',
      `label=com.docker.compose.project=${PROJECT}`,
    ]);
    if (listed.code !== 0) throw new DockerError(`could not list containers: ${listed.stderr.trim()}`);
    const ids = listed.stdout.split('\n').filter((line) => line.trim() !== '');
    if (ids.length === 0) return {};
    const inspected = await this.capture(['docker', 'inspect', ...ids]);
    if (inspected.code !== 0) throw new DockerError('could not inspect the containers');
    const result: Partial<Record<Service, Container>> = {};
    for (const item of JSON.parse(inspected.stdout) as InspectedContainer[]) {
      const labels = item.Config.Labels ?? {};
      const service = labels['com.docker.compose.service'] as Service | undefined;
      if (service !== 'runtime' && service !== 'postgres' && service !== 'tailscale') continue;
      if (result[service] !== undefined) throw new DockerError(`more than one ${service} container exists`);
      result[service] = {
        id: item.Id,
        service,
        status: item.State.Status,
        health: item.State.Health?.Status,
        imageId: item.Image,
        networkMode: item.HostConfig.NetworkMode,
        labels,
        mounts: (item.Mounts ?? []).map((mount) => ({
          type: mount.Type,
          name: mount.Name,
          source: mount.Source,
          destination: mount.Destination,
        })),
      };
    }
    return result;
  }

  /** The local image a reference names, or undefined if it is not present here. */
  async image(
    reference: string,
  ): Promise<{ id: string; cmd: string[]; env: string[]; workingDir: string } | undefined> {
    const result = await this.capture(['docker', 'image', 'inspect', reference]);
    if (result.code !== 0) return undefined;
    const [image] = JSON.parse(result.stdout) as {
      Id: string;
      Config: { Cmd: string[] | null; Env: string[] | null; WorkingDir: string };
    }[];
    if (image === undefined) return undefined;
    return {
      id: image.Id,
      cmd: image.Config.Cmd ?? [],
      env: image.Config.Env ?? [],
      workingDir: image.Config.WorkingDir,
    };
  }

  async volumeExists(name: string): Promise<boolean> {
    return (await this.capture(['docker', 'volume', 'inspect', name])).code === 0;
  }

  async tag(imageId: string, tag: string): Promise<void> {
    const result = await this.capture(['docker', 'tag', imageId, tag]);
    if (result.code !== 0) throw new DockerError(`could not tag ${imageId} as ${tag}: ${result.stderr.trim()}`);
  }

  /** The runtime's own readiness report, asked over its loopback listener. */
  async readiness(runtimeId: string): Promise<{ status: number; body: unknown }> {
    const script =
      "fetch('http://127.0.0.1:3000/readyz',{signal:AbortSignal.timeout(3000)})" +
      '.then(async(r)=>console.log(JSON.stringify({status:r.status,body:await r.json().catch(()=>null)})),' +
      '()=>console.log(JSON.stringify({status:0,body:null})))';
    const result = await this.capture(['docker', 'exec', runtimeId, 'bun', '-e', script], 10_000);
    if (result.code !== 0) return { status: 0, body: null };
    try {
      return JSON.parse(result.stdout.trim()) as { status: number; body: unknown };
    } catch {
      return { status: 0, body: null };
    }
  }

  async tailscaleStatus(tailscaleId: string): Promise<TailscaleStatus | undefined> {
    const result = await this.capture(['docker', 'exec', tailscaleId, 'tailscale', 'status', '--json'], 10_000);
    if (result.code !== 0 && result.stdout.trim() === '') return undefined;
    try {
      const status = JSON.parse(result.stdout) as {
        BackendState?: string;
        AuthURL?: string;
        Self?: { DNSName?: string; Online?: boolean };
      };
      return {
        backendState: status.BackendState ?? 'unknown',
        authUrl: status.AuthURL || undefined,
        dnsName: status.Self?.DNSName?.replace(/\.$/, '') || undefined,
        online: status.Self?.Online,
      };
    } catch {
      return undefined;
    }
  }

  async serveStatus(tailscaleId: string): Promise<string | undefined> {
    const result = await this.capture(['docker', 'exec', tailscaleId, 'tailscale', 'serve', 'status'], 10_000);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }
}

export interface TailscaleStatus {
  backendState: string;
  authUrl?: string;
  dnsName?: string;
  online?: boolean;
}
