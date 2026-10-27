// The owner-approved installation toolchain (task 5.3). The facet CLI is pinned by version and by the exact
// platform binary; nothing here downloads, upgrades or repairs it. Changing a pin is an explicit owner decision.

export const ADAPTER_NAME = 'agent-runtime';
export const ADAPTER_SDK_VERSION = '0.30.0';
export const ADAPTER_API = '0.3';

export interface PinnedCli {
  version: string;
  /** SHA-256 of the platform binary, keyed by `${process.platform}-${process.arch}`. */
  sha256: Readonly<Record<string, string>>;
}

export const PINNED_CLI: PinnedCli = Object.freeze({
  version: '0.36.5',
  sha256: Object.freeze({ 'linux-x64': '34cb805ceca1774cd53762c9a79eda5c1105dddb02af0fd8eb83f587b80fd5cb' }),
});

export interface CliIdentity {
  version: string;
  platform: string;
  sha256: string;
}

export class ToolchainError extends Error {
  override readonly name = 'ToolchainError';
}

export const platformKey = (platform: string = process.platform, arch: string = process.arch) => `${platform}-${arch}`;

/** Refuses an identity that is not the pinned binary for this platform. */
export function checkPinnedCli(identity: CliIdentity, pins: PinnedCli = PINNED_CLI): void {
  const expected = pins.sha256[identity.platform];
  if (expected === undefined) {
    throw new ToolchainError(`no facet CLI binary is pinned for platform ${identity.platform}`);
  }
  if (identity.version !== pins.version) {
    throw new ToolchainError(`facet CLI ${identity.version} is not the pinned version ${pins.version}`);
  }
  if (identity.sha256 !== expected) {
    throw new ToolchainError(`the facet CLI binary does not match the pinned SHA-256 for ${identity.platform}`);
  }
}

/** Reports a CLI binary's version and digest, whatever they are. Tests and caches record it; only sealing enforces it. */
export async function readCliIdentity(binary: string): Promise<CliIdentity> {
  const file = Bun.file(binary);
  if (!(await file.exists())) throw new ToolchainError(`the facet CLI was not found at ${binary}`);
  const sha256 = new Bun.CryptoHasher('sha256').update(await file.arrayBuffer()).digest('hex');
  const proc = Bun.spawn([binary, '--version'], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new ToolchainError('the facet CLI did not report its version');
  return { version: output.trim(), platform: platformKey(), sha256 };
}

/**
 * Establishes the identity of the pinned CLI. The binary's digest is checked before it is ever executed, so an
 * unpinned binary is refused without running it. The binary must already exist; it is never fetched.
 */
export async function verifyPinnedCli(binary: string, pins: PinnedCli = PINNED_CLI): Promise<CliIdentity> {
  const file = Bun.file(binary);
  if (!(await file.exists())) throw new ToolchainError(`the facet CLI was not found at ${binary}`);
  const platform = platformKey();
  const sha256 = new Bun.CryptoHasher('sha256').update(await file.arrayBuffer()).digest('hex');
  checkPinnedCli({ version: pins.version, platform, sha256 }, pins);
  const proc = Bun.spawn([binary, '--version'], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new ToolchainError('the facet CLI did not report its version');
  const identity = { version: output.trim(), platform, sha256 };
  checkPinnedCli(identity, pins);
  return identity;
}
