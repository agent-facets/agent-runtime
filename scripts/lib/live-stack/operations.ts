// What each `live:stack` command does. Every side effect goes through `Deps`, so the sequences are tested with a
// simulated Docker. Ordinary lifecycle commands never build, pull or change the selected image; only `deploy` does,
// and only after confirmation. Nothing here removes a volume, an image or a Tailscale identity.
import { join } from 'node:path';
import { repoRoot } from '../workspace.ts';
import { type Invocation, type Parsed, PROJECT, SERVICES, type Service, USAGE } from './args.ts';
import { COMPOSE_FILE, type Container, composeArgs, Docker, deployTag, type Runner } from './docker.ts';
import type { AcquireLock } from './lock.ts';
import {
  checkPrivateFile,
  type DeploymentState,
  ensurePrivateDir,
  type Paths,
  type PendingOperation,
  pathsFor,
  readEnvFile,
  readState,
  requireState,
  VOLUMES,
  writeState,
} from './state.ts';

export interface Timeouts {
  readinessMs: number;
  postgresMs: number;
  tailscaleMs: number;
  pollMs: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  readinessMs: 120_000,
  postgresMs: 60_000,
  tailscaleMs: 60_000,
  pollMs: 2_000,
};

export interface Deps {
  runner: Runner;
  ambient: Record<string, string | undefined>;
  acquireLock: AcquireLock;
  out: (line: string) => void;
  /** Whether standard input is a terminal: prompts and interactive commands need one. */
  interactive: boolean;
  /** Asks the operator; true only for an explicit yes. */
  prompt: (question: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeouts?: Timeouts;
}

/** A refusal or failure reported to the operator; exit status 1. */
export class OperationError extends Error {
  override readonly name = 'OperationError';
}

const STOP_TIMEOUT = ['-t', '30'];
const RECREATE = ['up', '-d', '--no-deps', '--force-recreate', '--no-build', '--pull', 'never'];
const short = (id: string) => id.slice('sha256:'.length, 'sha256:'.length + 12);

/** The image a dependency service is pinned to in compose.yaml. */
export async function configuredImage(service: 'postgres' | 'tailscale'): Promise<string> {
  const compose = Bun.YAML.parse(await Bun.file(COMPOSE_FILE).text()) as {
    services: Record<string, { image?: string }>;
  };
  const image = compose.services[service]?.image;
  if (image === undefined) throw new OperationError(`compose.yaml names no image for ${service}`);
  return image;
}

class Live {
  readonly docker: Docker;
  readonly paths: Paths;
  readonly timeouts: Timeouts;

  constructor(
    readonly deps: Deps,
    stateDir: string,
  ) {
    this.docker = new Docker(deps.runner, deps.ambient);
    this.paths = pathsFor(stateDir);
    this.timeouts = deps.timeouts ?? DEFAULT_TIMEOUTS;
  }

  out(line = '') {
    this.deps.out(line);
  }

  /** Holds the management lock; the state directory must already exist. */
  async locked<T>(fn: () => Promise<T>): Promise<T> {
    await requireState(this.paths);
    await ensurePrivateDir(this.paths.stateDir);
    const lock = await this.deps.acquireLock(this.paths.lockFile);
    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }

  /** Runs a Compose command against this deployment, with the selected image named by its deployment tag. */
  async compose(state: DeploymentState, args: string[], options: { stdin?: boolean; image?: string } = {}) {
    const image = options.image ?? state.images.runtime;
    const result = await this.deps.runner([...composeArgs(this.paths.envFile), ...args], {
      env: this.docker.env({ AGENT_RUNTIME_IMAGE: deployTag(image) }),
      stdin: options.stdin,
    });
    return result.code;
  }

  async mustCompose(state: DeploymentState, args: string[], what: string, image?: string) {
    const code = await this.compose(state, args, { image });
    if (code !== 0) throw new OperationError(`${what} failed (docker compose exited ${code})`);
  }

  async confirm(yes: boolean, question: string) {
    if (yes) return;
    if (!this.deps.interactive) throw new OperationError('this needs confirmation: run it again with --yes');
    if (!(await this.deps.prompt(question))) throw new OperationError('cancelled; nothing was changed');
  }

  async waitFor(what: string, timeoutMs: number, check: () => Promise<boolean>) {
    const start = this.deps.now();
    for (;;) {
      if (await check()) return;
      if (this.deps.now() - start >= timeoutMs) {
        throw new OperationError(`${what} did not happen within ${Math.round(timeoutMs / 1000)} seconds`);
      }
      await this.deps.sleep(this.timeouts.pollMs);
    }
  }

  async waitReady(runtimeId: string) {
    let last: { status: number; body: unknown } = { status: 0, body: null };
    try {
      await this.waitFor('runtime readiness', this.timeouts.readinessMs, async () => {
        last = await this.docker.readiness(runtimeId);
        return last.status === 200;
      });
    } catch (error) {
      const checks = (last.body as { checks?: unknown } | null)?.checks;
      const detail = checks === undefined ? '' : ` (last report: ${JSON.stringify(checks)})`;
      throw new OperationError(
        `${(error as Error).message}${detail}; see \`bun run live:stack logs\` and \`bun run live:stack status\``,
      );
    }
    this.out('the runtime is ready');
  }

  async requireVolumes() {
    for (const name of Object.values(VOLUMES)) {
      if (!(await this.docker.volumeExists(name))) {
        throw new OperationError(
          `the volume ${name} does not exist; refusing to continue, because Compose would create it empty`,
        );
      }
    }
  }

  /** Checks that compose.yaml still pins the dependency image the deployment was adopted with. */
  async checkDependencyImage(state: DeploymentState, service: 'postgres' | 'tailscale') {
    const reference = await configuredImage(service);
    const image = await this.docker.image(reference);
    if (image === undefined) {
      throw new OperationError(
        `the ${service} image is not present locally; pull it explicitly: docker pull ${reference}`,
      );
    }
    if (image.id !== state.images[service]) {
      throw new OperationError(
        `compose.yaml now pins a different ${service} image (${short(image.id)}) than this deployment uses ` +
          `(${short(state.images[service])}); changing dependency images is not a live:stack operation`,
      );
    }
  }

  /**
   * Makes Tailscale and PostgreSQL run: starts stopped containers and, when `create` allows it, creates missing ones
   * from the adopted images on the existing volumes. Returns the current containers.
   */
  async ensureDependencies(state: DeploymentState, create: boolean) {
    let containers = await this.docker.containers();
    for (const service of ['tailscale', 'postgres'] as const) {
      const container = containers[service];
      if (container === undefined) {
        if (!create) {
          throw new OperationError(
            `the ${service} container does not exist: run \`bun run live:stack deploy --image ${state.images.runtime}\``,
          );
        }
        await this.checkDependencyImage(state, service);
        this.out(`creating the ${service} container on its existing volume`);
        await this.mustCompose(state, [...RECREATE, service], `creating ${service}`);
      } else if (container.status !== 'running') {
        this.out(`starting ${service}`);
        await this.mustCompose(state, ['start', service], `starting ${service}`);
      }
    }
    await this.waitFor('PostgreSQL becoming healthy', this.timeouts.postgresMs, async () => {
      containers = await this.docker.containers();
      return containers.postgres?.health === 'healthy';
    });
    await this.waitTailscale(containers);
    return containers;
  }

  async waitTailscale(containers: Partial<Record<Service, Container>>) {
    const id = containers.tailscale?.id;
    if (id === undefined) throw new OperationError('the Tailscale container does not exist');
    await this.waitFor('the Tailscale node connecting', this.timeouts.tailscaleMs, async () => {
      const status = await this.docker.tailscaleStatus(id);
      if (status?.backendState === 'NeedsLogin') {
        throw new OperationError(
          'the Tailscale node is not signed in: run `bun run live:stack tailscale enroll`, then `bun run live:stack tailscale recover`',
        );
      }
      return status?.backendState === 'Running';
    });
  }

  /** Recreates only the runtime on `imageId` and checks it is attached to the current Tailscale container. */
  async recreateRuntime(state: DeploymentState, imageId: string): Promise<Container> {
    await this.docker.tag(imageId, deployTag(imageId));
    this.out(`recreating the runtime on ${short(imageId)}`);
    await this.mustCompose(state, [...RECREATE, 'runtime'], 'recreating the runtime', imageId);
    const containers = await this.docker.containers();
    const runtime = containers.runtime;
    if (runtime === undefined) throw new OperationError('the runtime container was not created');
    if (runtime.imageId !== imageId) {
      throw new OperationError(`the runtime runs ${short(runtime.imageId)}, not ${short(imageId)}`);
    }
    if (runtime.networkMode !== `container:${containers.tailscale?.id}`) {
      throw new OperationError('the runtime is not attached to the current Tailscale container');
    }
    return runtime;
  }

  async saveState(state: DeploymentState, pending: PendingOperation | undefined, runtime = state.images.runtime) {
    const next: DeploymentState = {
      ...state,
      images: { ...state.images, runtime },
      updatedAt: new Date(this.deps.now()).toISOString(),
    };
    if (pending === undefined) delete next.pending;
    else next.pending = pending;
    await writeState(this.paths, next);
    return next;
  }

  async prepare() {
    const state = await requireState(this.paths);
    await readEnvFile(this.paths.envFile);
    return state;
  }

  refuseWhilePending(state: DeploymentState) {
    const pending = state.pending;
    if (pending === undefined) return;
    if (pending.kind === 'deploy') {
      throw new OperationError(
        `a deployment did not finish (from ${short(pending.from)} to ${short(pending.to)}): finish it with ` +
          `\`deploy --image ${pending.to}\`, or go back with \`deploy --image ${pending.from}\``,
      );
    }
    throw new OperationError(
      'a Tailscale recovery did not finish: finish it with `bun run live:stack tailscale recover`',
    );
  }

  describePending(pending: PendingOperation | undefined): string | undefined {
    if (pending === undefined) return undefined;
    if (pending.kind === 'deploy') {
      return `unfinished deployment from ${short(pending.from)} to ${short(pending.to)} (${pending.phase}, started ${pending.startedAt})`;
    }
    return `unfinished Tailscale recovery (${pending.phase}, started ${pending.startedAt})`;
  }

  // Commands

  async status(): Promise<number> {
    const state = await readState(this.paths);
    let host: string | undefined;
    if ((await checkPrivateFile(this.paths.envFile)) === 'present') {
      host = (await readEnvFile(this.paths.envFile)).get('AGENT_RUNTIME_PUBLIC_HOST');
    }
    this.out(`project    ${PROJECT}`);
    this.out(`url        ${host === undefined ? '(no environment file)' : `https://${host}`}`);
    this.out(
      `selected   ${state === undefined ? `no deployment state in ${this.paths.stateDir}` : state.images.runtime}`,
    );
    const pending = this.describePending(state?.pending);
    if (pending !== undefined) this.out(`pending    ${pending}`);
    const containers = await this.docker.containers();
    this.out();
    for (const service of SERVICES) {
      const container = containers[service];
      if (container === undefined) {
        this.out(`${service.padEnd(10)} missing`);
        continue;
      }
      const notes: string[] = [];
      if (service === 'runtime' && state !== undefined && container.imageId !== state.images.runtime) {
        notes.push('differs from the selected image');
      }
      if (service !== 'runtime' && state !== undefined && container.imageId !== state.images[service]) {
        notes.push('differs from the adopted image');
      }
      if (
        service === 'runtime' &&
        container.status === 'running' &&
        container.networkMode !== `container:${containers.tailscale?.id}`
      ) {
        notes.push('not attached to the current Tailscale container: run `tailscale recover`');
      }
      const health = container.health === undefined ? '' : ` (${container.health})`;
      const note = notes.length === 0 ? '' : `  ! ${notes.join('; ')}`;
      this.out(`${service.padEnd(10)} ${container.status}${health}  ${short(container.imageId)}${note}`);
    }
    this.out();
    const runtime = containers.runtime;
    if (runtime?.status === 'running') {
      const report = await this.docker.readiness(runtime.id);
      const checks = (report.body as { checks?: unknown } | null)?.checks;
      const verdict = report.status === 200 ? 'ready' : report.status === 0 ? 'no answer' : 'not ready';
      this.out(`readiness  ${verdict}${checks === undefined ? '' : ` ${JSON.stringify(checks)}`}`);
    } else {
      this.out('readiness  the runtime is not running');
    }
    const tailscale = containers.tailscale;
    if (tailscale?.status === 'running') {
      const node = await this.docker.tailscaleStatus(tailscale.id);
      this.out(
        `tailscale  ${node === undefined ? 'no answer' : `${node.backendState}${node.dnsName ? ` as ${node.dnsName}` : ''}`}`,
      );
    } else {
      this.out('tailscale  the container is not running');
    }
    return 0;
  }

  async logs(invocation: Extract<Invocation, { command: 'logs' }>): Promise<number> {
    const state = await this.prepare();
    const follow = invocation.follow ? ['-f'] : [];
    const tail = invocation.options.includes('--tail') ? [] : ['--tail', '200'];
    return this.compose(state, ['logs', ...follow, ...tail, ...invocation.options, ...invocation.services]);
  }

  async start(): Promise<number> {
    return this.locked(async () => {
      const state = await this.prepare();
      const containers = await this.docker.containers();
      const missing = SERVICES.filter((service) => containers[service] === undefined);
      if (missing.length > 0) {
        throw new OperationError(
          `no container for ${missing.join(', ')}; \`start\` does not create containers. ` +
            `Create them on the selected image with \`bun run live:stack deploy --image ${state.images.runtime}\``,
        );
      }
      if (state.pending !== undefined) this.out(`warning: ${this.describePending(state.pending)}`);
      if (containers.runtime?.status === 'running' && containers.tailscale?.status !== 'running') {
        // The runtime would keep the namespace of a Tailscale container that is no longer running.
        this.out('stopping the runtime first: its Tailscale container is not running');
        await this.mustCompose(state, ['stop', ...STOP_TIMEOUT, 'runtime'], 'stopping the runtime');
      }
      await this.mustCompose(state, ['start'], 'starting the deployment');
      const runtime = (await this.docker.containers()).runtime as Container;
      if (runtime.imageId !== state.images.runtime) {
        this.out(
          `warning: the runtime container runs ${short(runtime.imageId)}, not the selected ${short(state.images.runtime)}`,
        );
      }
      await this.waitReady(runtime.id);
      return 0;
    });
  }

  async stop(runtimeOnly: boolean): Promise<number> {
    return this.locked(async () => {
      const state = await this.prepare();
      await this.mustCompose(state, ['stop', ...STOP_TIMEOUT, ...(runtimeOnly ? ['runtime'] : [])], 'stopping');
      this.out(runtimeOnly ? 'the runtime is stopped' : 'every service is stopped; containers and volumes are kept');
      return 0;
    });
  }

  async restart(): Promise<number> {
    return this.locked(async () => {
      const state = await this.prepare();
      const containers = await this.docker.containers();
      if (containers.runtime === undefined) throw new OperationError('the runtime container does not exist');
      if (containers.tailscale?.status !== 'running' || containers.postgres?.status !== 'running') {
        throw new OperationError('Tailscale or PostgreSQL is not running: use `bun run live:stack start`');
      }
      await this.mustCompose(state, ['restart', ...STOP_TIMEOUT, 'runtime'], 'restarting the runtime');
      this.out(
        'restarted; the container keeps its configuration. After changing the environment or configuration file, use `reload`.',
      );
      await this.waitReady(containers.runtime.id);
      return 0;
    });
  }

  async recreate(): Promise<number> {
    return this.locked(async () => {
      const state = await this.prepare();
      this.refuseWhilePending(state);
      await this.requireVolumes();
      await this.ensureDependencies(state, false);
      const runtime = await this.recreateRuntime(state, state.images.runtime);
      await this.waitReady(runtime.id);
      return 0;
    });
  }

  async down(yes: boolean): Promise<number> {
    return this.locked(async () => {
      const state = await this.prepare();
      this.out('This removes the containers and network. Volumes, the Tailscale identity and the selected image stay.');
      await this.confirm(yes, 'Remove the live containers?');
      await this.mustCompose(state, ['down', ...STOP_TIMEOUT], 'removing the containers');
      this.out(`removed. Create them again with \`bun run live:stack deploy --image ${state.images.runtime}\``);
      return 0;
    });
  }

  async build(): Promise<number> {
    const git = async (args: string[]) => (await this.docker.capture(['git', '-C', repoRoot, ...args])).stdout.trim();
    const commit = (await git(['rev-parse', '--short=12', 'HEAD'])) || 'unknown';
    const dirty = (await git(['status', '--porcelain'])) === '' ? '' : '-dirty';
    const stamp = new Date(this.deps.now()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    const tag = `agent-runtime/runtime:release-${stamp}-${commit}${dirty}`;
    if ((await this.docker.image(tag)) !== undefined) throw new OperationError(`the image ${tag} already exists`);
    if (dirty !== '') this.out('warning: the checkout has uncommitted changes; they are built into this image');
    const { code } = await this.deps.runner(
      ['docker', 'build', '--target', 'runtime', '--file', join(repoRoot, 'Dockerfile'), '--tag', tag, repoRoot],
      { env: this.docker.env() },
    );
    if (code !== 0) throw new OperationError(`the build failed (docker build exited ${code}); nothing was deployed`);
    const image = await this.docker.image(tag);
    if (image === undefined) throw new OperationError(`the build did not produce ${tag}`);
    this.out(`built ${tag}`);
    this.out(`image ${image.id}`);
    this.out(`nothing was deployed. To deploy it: bun run live:stack deploy --image ${tag}`);
    return 0;
  }

  async deploy(reference: string, yes: boolean): Promise<number> {
    return this.locked(async () => {
      let state = await this.prepare();
      const image = await this.docker.image(reference);
      if (image === undefined) {
        throw new OperationError(`the image ${reference} is not present locally; build it or pull it explicitly first`);
      }
      if (image.cmd.join(' ') !== 'bun dist/main.js' || !image.env.includes('NODE_ENV=production')) {
        throw new OperationError(`${reference} is not a production runtime image`);
      }
      const target = image.id;
      const pending = state.pending;
      if (pending?.kind === 'tailscale-recover') this.refuseWhilePending(state);
      if (pending?.kind === 'deploy' && target !== pending.to && target !== pending.from)
        this.refuseWhilePending(state);
      await this.requireVolumes();

      const containers = await this.docker.containers();
      const running = containers.runtime;
      if (
        pending === undefined &&
        target === state.images.runtime &&
        running?.status === 'running' &&
        running.imageId === target &&
        running.networkMode === `container:${containers.tailscale?.id}`
      ) {
        this.out(`${short(target)} is already deployed and running; nothing to do`);
        return 0;
      }

      this.out(`selected now  ${state.images.runtime}`);
      this.out(
        `running now   ${running === undefined ? 'no runtime container' : `${running.imageId} (${running.status})`}`,
      );
      this.out(`deploy        ${target} (${reference})`);
      this.out();
      this.out('- Work in progress is interrupted. Runs waiting for an answer may not continue under another build.');
      this.out('- A newer image can apply database migrations. An older image cannot then use the database.');
      this.out('- Nothing is rolled back automatically if the deployment fails.');
      await this.confirm(yes, `Deploy ${short(target)} to ${PROJECT}?`);

      state = await this.saveState(state, {
        kind: 'deploy',
        from: state.images.runtime,
        to: target,
        phase: 'started',
        startedAt: new Date(this.deps.now()).toISOString(),
      });
      try {
        await this.ensureDependencies(state, true);
        const runtime = await this.recreateRuntime(state, target);
        state = await this.saveState(state, {
          ...(state.pending as PendingOperation & { kind: 'deploy' }),
          phase: 'runtime-recreated',
        });
        await this.waitReady(runtime.id);
      } catch (error) {
        const from = (state.pending as { from: string }).from;
        throw new OperationError(
          `${(error as Error).message}\nThe deployment did not finish and is recorded as unfinished. ` +
            `To try again: \`bun run live:stack deploy --image ${target}\`. To go back: ` +
            `\`bun run live:stack deploy --image ${from}\` (not possible if the new image changed the database).`,
        );
      }
      await this.saveState(state, undefined, target);
      this.out(`deployed ${target}`);
      return 0;
    });
  }

  async auth(offline: boolean, args: string[]): Promise<number> {
    const command = ['bun', 'dist/auth.js', ...args];
    if (!offline) {
      await this.prepare();
      const runtime = (await this.docker.containers()).runtime;
      if (runtime?.status !== 'running') {
        throw new OperationError('the runtime is not running: use `auth --offline ...` to run the command without it');
      }
      const tty = this.deps.interactive ? ['-it'] : ['-i'];
      const { code } = await this.deps.runner(['docker', 'exec', ...tty, runtime.id, ...command], {
        env: this.docker.env(),
        stdin: true,
      });
      return code;
    }
    return this.locked(async () => {
      const state = await this.prepare();
      const containers = await this.docker.containers();
      if (containers.runtime?.status === 'running') {
        throw new OperationError('the runtime is running: stop it first with `bun run live:stack stop runtime`');
      }
      if (containers.postgres?.health !== 'healthy' || containers.tailscale?.status !== 'running') {
        throw new OperationError(
          'PostgreSQL and Tailscale must be running: use `bun run live:stack start`, then `stop runtime`',
        );
      }
      await this.docker.tag(state.images.runtime, deployTag(state.images.runtime));
      const tty = this.deps.interactive ? [] : ['-T'];
      return this.compose(state, ['run', '--rm', '--no-deps', '--pull', 'never', ...tty, 'runtime', ...command], {
        stdin: true,
      });
    });
  }

  async tailscaleStatus(): Promise<number> {
    await this.prepare();
    const containers = await this.docker.containers();
    const tailscale = containers.tailscale;
    if (tailscale?.status !== 'running') {
      this.out('the Tailscale container is not running');
      return 1;
    }
    const node = await this.docker.tailscaleStatus(tailscale.id);
    this.out(`state      ${node?.backendState ?? 'no answer'}`);
    if (node?.dnsName !== undefined) this.out(`name       ${node.dnsName}`);
    if (node?.online !== undefined) this.out(`online     ${node.online ? 'yes' : 'no'}`);
    const attached = containers.runtime?.networkMode === `container:${tailscale.id}`;
    this.out(`runtime    ${attached ? 'attached to this container' : 'not attached: run `tailscale recover`'}`);
    const serve = await this.docker.serveStatus(tailscale.id);
    this.out();
    this.out(serve === undefined || serve === '' ? 'Serve: no configuration reported' : serve);
    return 0;
  }

  async tailscaleEnroll(): Promise<number> {
    await this.prepare();
    const tailscale = (await this.docker.containers()).tailscale;
    if (tailscale?.status !== 'running') {
      this.out('the Tailscale container is not running: start it with `bun run live:stack start`');
      return 1;
    }
    const node = await this.docker.tailscaleStatus(tailscale.id);
    if (node?.backendState === 'Running') {
      this.out(`the node is enrolled${node.dnsName ? ` as ${node.dnsName}` : ''}; nothing to do`);
      return 0;
    }
    this.out(`state: ${node?.backendState ?? 'no answer'}`);
    if (node?.authUrl !== undefined) this.out(`open this link to add the node to your tailnet: ${node.authUrl}`);
    else this.out('read the login link with `bun run live:stack logs tailscale --no-follow`');
    this.out('Alternatively, create a one-time auth key in the Tailscale admin console and run');
    this.out(`  docker exec -it ${tailscale.id.slice(0, 12)} tailscale login --auth-key=<key>`);
    this.out('Do not install Tailscale on the host for this; only the container joins.');
    this.out('After the node joins, run `bun run live:stack tailscale recover` to reattach the runtime.');
    return 0;
  }

  async tailscaleRecover(yes: boolean): Promise<number> {
    return this.locked(async () => {
      let state = await this.prepare();
      if (state.pending?.kind === 'deploy') this.refuseWhilePending(state);
      await this.requireVolumes();
      const resuming = state.pending?.kind === 'tailscale-recover' ? state.pending : undefined;
      this.out(
        resuming?.phase === 'tailscale-recreated'
          ? 'Continuing an unfinished recovery: the Tailscale container was already recreated.'
          : 'This stops the runtime, recreates the Tailscale container on its existing identity volume, then recreates the runtime.',
      );
      this.out('Work in progress is interrupted. The console is unavailable until the runtime is ready again.');
      await this.confirm(yes, 'Recover the Tailscale container?');

      state = await this.saveState(
        state,
        resuming ?? { kind: 'tailscale-recover', phase: 'started', startedAt: new Date(this.deps.now()).toISOString() },
      );
      try {
        if (resuming?.phase !== 'tailscale-recreated') {
          await this.checkDependencyImage(state, 'tailscale');
          const containers = await this.docker.containers();
          if (containers.runtime !== undefined) {
            await this.mustCompose(state, ['stop', ...STOP_TIMEOUT, 'runtime'], 'stopping the runtime');
          }
          this.out('recreating the Tailscale container');
          await this.mustCompose(state, [...RECREATE, 'tailscale'], 'recreating Tailscale');
          state = await this.saveState(state, {
            ...(state.pending as PendingOperation & { kind: 'tailscale-recover' }),
            phase: 'tailscale-recreated',
          });
        }
        await this.ensureDependencies(state, false);
        const runtime = await this.recreateRuntime(state, state.images.runtime);
        await this.waitReady(runtime.id);
      } catch (error) {
        throw new OperationError(
          `${(error as Error).message}\nThe recovery did not finish and is recorded as unfinished; ` +
            'run `bun run live:stack tailscale recover` again to continue it.',
        );
      }
      await this.saveState(state, undefined);
      this.out('recovered');
      return 0;
    });
  }
}

export async function execute(parsed: Parsed, deps: Deps): Promise<number> {
  const live = new Live(deps, parsed.stateDir);
  const invocation = parsed.invocation;
  switch (invocation.command) {
    case 'help':
      deps.out(USAGE);
      return 0;
    case 'status':
      return live.status();
    case 'logs':
      return live.logs(invocation);
    case 'start':
      return live.start();
    case 'stop':
      return live.stop(invocation.runtimeOnly);
    case 'restart':
      return live.restart();
    case 'recreate':
      return live.recreate();
    case 'down':
      return live.down(invocation.yes);
    case 'build':
      return live.build();
    case 'deploy':
      return live.deploy(invocation.image, invocation.yes);
    case 'auth':
      return live.auth(invocation.offline, invocation.args);
    case 'tailscale-status':
      return live.tailscaleStatus();
    case 'tailscale-enroll':
      return live.tailscaleEnroll();
    case 'tailscale-recover':
      return live.tailscaleRecover(invocation.yes);
  }
}
