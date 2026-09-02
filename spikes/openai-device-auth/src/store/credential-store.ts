// The credential store.
//
// One file and one lock file per provider, under a single 0700 directory. The
// architecture asks for a provider-namespaced store; splitting the files is
// what makes "single-flight per provider" true rather than aspirational, since
// a shared document would serialise an Anthropic refresh behind an OpenAI one.
// Namespace preservation stays a real property and is asserted by digesting the
// sibling file across every crash.
//
// Coalescing is two layers, and both are needed:
//
//   in-process promise map   collapses N concurrent callers in one process
//   kernel flock             collapses N processes on one host
//
// The lock holder rereads before refreshing. If a peer already advanced the
// generation and left a usable token, the holder adopts it and makes no
// upstream call at all -- which is the entire point of the exercise, because a
// concurrent refresh against a rotating refresh token produces a cascade of
// 401s.

import { readFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { Clock } from "../clock.ts";
import { AuthError } from "../auth/errors.ts";
import type { RefreshResponse } from "../auth/refresh.ts";
import { DEFAULT_RETRY_POLICY, withBoundedRetry, type RetryPolicy } from "../auth/refresh.ts";
import { REFRESH_MARGIN_SECONDS } from "../reference.ts";
import { atomicWrite, type WriteHooks, type WriteMode } from "./atomic-write.ts";
import { acquireLock, ensureLockFile, LockTimeoutError } from "./lock.ts";

export const STORE_SCHEMA = "agent-runtime/credential-store/1";

export type CredentialState = "active" | "relogin_required";

export type Credential = {
  provider: string;
  type: "oauth" | "api_key";
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  account_id: string | null;
  scopes: string[];
  profile_id: string;
  created_at: number;
  rotated_at: number;
  state: CredentialState;
};

export type ProviderFile = {
  schema: typeof STORE_SCHEMA;
  provider: string;
  generation: number;
  credential: Credential;
};

export type StoreMetrics = {
  upstreamRefreshes: number;
  lockAcquisitions: number;
  guardedAdoptions: number;
  readRetries: number;
  commits: number;
};

export type StoreOptions = {
  directory: string;
  clock: Clock;
  refresh: (credential: Credential) => Promise<RefreshResponse>;
  marginSeconds?: number;
  lockTimeoutMs?: number;
  retryPolicy?: RetryPolicy;
  writeHooks?: WriteHooks;
  writeMode?: WriteMode;
  /** Negative controls. Each defaults on; turning one off must break a test. */
  singleFlight?: boolean;
  crossProcessLock?: boolean;
  guardedReread?: boolean;
};

export class CredentialStore {
  readonly metrics: StoreMetrics = {
    upstreamRefreshes: 0,
    lockAcquisitions: 0,
    guardedAdoptions: 0,
    readRetries: 0,
    commits: 0,
  };

  readonly directory: string;

  #options: StoreOptions;
  #inflight = new Map<string, Promise<string>>();
  #highestGeneration = new Map<string, number>();

  constructor(options: StoreOptions) {
    this.#options = options;
    this.directory = options.directory;
  }

  pathFor(provider: string): string {
    return join(this.directory, `${provider}.json`);
  }

  lockPathFor(provider: string): string {
    return join(this.directory, `${provider}.lock`);
  }

  async initialise(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  /**
   * Lock-free read with exactly one retry.
   *
   * A reader can catch the instant between the rename and its own open, so a
   * single retry is required. A second failure is reported as contention
   * rather than retried again: an unbounded retry loop turns a real corruption
   * into a hang.
   */
  async read(provider: string): Promise<ProviderFile | null> {
    const path = this.pathFor(provider);

    const attempt = async (): Promise<
      { ok: true; file: ProviderFile | null } | { ok: false; reason: string }
    > => {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { ok: true, file: null };
        }
        return { ok: false, reason: `read failed: ${(error as Error).message}` };
      }

      const parsed = parseProviderFile(raw, provider);
      if (!parsed) return { ok: false, reason: "unparsable or malformed store document" };
      return { ok: true, file: parsed };
    };

    let result = await attempt();
    if (!result.ok) {
      this.metrics.readRetries += 1;
      result = await attempt();
    }
    if (!result.ok) throw new AuthError("STORE_CONTENDED", result.reason);

    if (result.file) this.#assertMonotonic(provider, result.file.generation);
    return result.file;
  }

  #assertMonotonic(provider: string, generation: number): void {
    const seen = this.#highestGeneration.get(provider);
    if (seen !== undefined && generation < seen) {
      throw new AuthError(
        "GENERATION_REGRESSION",
        `store generation for ${provider} went backwards`,
      );
    }
    this.#highestGeneration.set(provider, Math.max(seen ?? 0, generation));
  }

  /** First persistence after a device login. */
  async install(credential: Credential): Promise<ProviderFile> {
    await this.initialise();
    const existing = await this.read(credential.provider);
    return this.#commit(credential, (existing?.generation ?? 0) + 1);
  }

  async #commit(credential: Credential, generation: number): Promise<ProviderFile> {
    const file: ProviderFile = {
      schema: STORE_SCHEMA,
      provider: credential.provider,
      generation,
      credential,
    };
    await atomicWrite(
      this.pathFor(credential.provider),
      `${JSON.stringify(file, null, 2)}\n`,
      this.#options.writeHooks ?? {},
      this.#options.writeMode ?? "atomic",
    );
    this.metrics.commits += 1;
    this.#highestGeneration.set(credential.provider, generation);
    return file;
  }

  needsRefresh(credential: Credential): boolean {
    const margin = this.#options.marginSeconds ?? REFRESH_MARGIN_SECONDS;
    const nowSeconds = Math.floor(this.#options.clock.now() / 1000);
    return credential.expires_at - nowSeconds <= margin;
  }

  /**
   * The single entry point callers use. Returns a usable access token,
   * refreshing at most once across every concurrent caller on the host.
   */
  async getAccessToken(provider: string): Promise<string> {
    if (this.#options.singleFlight === false) return this.#resolve(provider);

    const existing = this.#inflight.get(provider);
    if (existing) return existing;

    const pending = this.#resolve(provider).finally(() => {
      this.#inflight.delete(provider);
    });
    this.#inflight.set(provider, pending);
    return pending;
  }

  async #resolve(provider: string): Promise<string> {
    const current = await this.read(provider);
    if (!current) throw new AuthError("RELOGIN_REQUIRED", `no credential for ${provider}`);
    if (current.credential.state === "relogin_required") {
      throw new AuthError("RELOGIN_REQUIRED", `${provider} needs an interactive login`);
    }
    if (!this.needsRefresh(current.credential)) return current.credential.access_token;

    return this.#refreshUnderLock(provider, current);
  }

  async #refreshUnderLock(provider: string, before: ProviderFile): Promise<string> {
    ensureLockFile(this.lockPathFor(provider));

    let lock;
    try {
      lock = await acquireLock(this.lockPathFor(provider), {
        timeoutMs: this.#options.lockTimeoutMs ?? 30_000,
        enabled: this.#options.crossProcessLock !== false,
      });
    } catch (error) {
      if (error instanceof LockTimeoutError) {
        throw new AuthError("LOCK_TIMEOUT", error.message);
      }
      throw error;
    }
    this.metrics.lockAcquisitions += 1;

    try {
      let current = before;

      if (this.#options.guardedReread !== false) {
        const fresh = await this.read(provider);
        if (!fresh) throw new AuthError("RELOGIN_REQUIRED", `no credential for ${provider}`);
        current = fresh;

        // A peer refreshed while this caller waited for the lock.
        if (fresh.generation > before.generation && !this.needsRefresh(fresh.credential)) {
          this.metrics.guardedAdoptions += 1;
          return fresh.credential.access_token;
        }
        if (fresh.credential.state === "relogin_required") {
          throw new AuthError("RELOGIN_REQUIRED", `${provider} needs an interactive login`);
        }
      }

      const response = await withBoundedRetry(
        async () => {
          this.metrics.upstreamRefreshes += 1;
          return this.#options.refresh(current.credential);
        },
        this.#options.retryPolicy ?? DEFAULT_RETRY_POLICY,
        this.#options.clock,
      ).catch(async (error: unknown) => {
        // A permanent failure disables the credential without discarding the
        // refresh token: keeping it costs nothing and is the only thing that
        // makes the failure diagnosable afterwards.
        if (error instanceof AuthError && error.kind === "permanent") {
          await this.#commit(
            { ...current.credential, state: "relogin_required" },
            current.generation + 1,
          );
        }
        throw error;
      });

      const merged = mergeRotation(current.credential, response, this.#options.clock);
      await this.#commit(merged, current.generation + 1);
      return merged.access_token;
    } finally {
      await lock.release();
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Partial rotation: every field is merged individually. The issuer routinely
 * returns a new access token and omits the refresh token, and overwriting the
 * stored refresh token with `undefined` there would strand the credential.
 */
export function mergeRotation(
  current: Credential,
  response: RefreshResponse,
  clock: Clock,
): Credential {
  return {
    ...current,
    access_token: response.accessToken ?? current.access_token,
    refresh_token: response.refreshToken ?? current.refresh_token,
    expires_at: response.expiresAtSeconds ?? current.expires_at,
    rotated_at: Math.floor(clock.now() / 1000),
    state: "active",
  };
}

export function parseProviderFile(raw: string, provider: string): ProviderFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const file = parsed as Partial<ProviderFile>;
  if (file.schema !== STORE_SCHEMA) return null;
  if (file.provider !== provider) return null;
  if (typeof file.generation !== "number" || !Number.isInteger(file.generation)) return null;

  const credential = file.credential as Partial<Credential> | undefined;
  if (!credential || typeof credential.access_token !== "string") return null;
  if (typeof credential.expires_at !== "number") return null;

  return file as ProviderFile;
}

export async function fileMode(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return null;
  }
}

export async function fileOwner(path: string): Promise<number | null> {
  try {
    return (await stat(path)).uid;
  } catch {
    return null;
  }
}
