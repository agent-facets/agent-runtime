// The reference oracle: the shipped @ex-machina/opencode-anthropic-auth plugin,
// executed as a black box.
//
// The plugin's real loader is invoked with a fake OpenCode client and a sentinel
// OAuth record whose expiry is far in the future, so no refresh path runs. None
// of the plugin's internal transform functions are imported: duplicating them
// and comparing against the duplicate would prove only self-consistency.
//
// The plugin's wrapper calls the global fetch, so the capture sink is installed
// over globalThis.fetch for the duration of each call.

import { AnthropicAuthPlugin } from "@ex-machina/opencode-anthropic-auth";

type FetchInput = string | URL | Request;

export type ReferenceLane = {
  fetch: (input: FetchInput, init?: RequestInit) => Promise<Response>;
  authSetCalls: number;
};

export type ReferenceOptions = {
  accessToken: string;
  refreshToken: string;
  terminal: (input: FetchInput, init?: RequestInit) => Promise<Response>;
};

export async function createReferenceLane(
  options: ReferenceOptions,
): Promise<ReferenceLane> {
  const lane: ReferenceLane = {
    fetch: async () => {
      throw new Error("reference lane not initialised");
    },
    authSetCalls: 0,
  };

  const fakeClient = {
    auth: {
      set: async () => {
        // A refresh must never happen in an offline run; count it if it does.
        lane.authSetCalls += 1;
      },
    },
  };

  const plugin = (await AnthropicAuthPlugin({
    client: fakeClient,
  } as never)) as unknown as {
    auth: {
      provider: string;
      loader: (
        getAuth: () => Promise<Record<string, unknown>>,
        provider: { models: Record<string, { cost: unknown }> },
      ) => Promise<{
        apiKey?: string;
        fetch?: (input: FetchInput, init?: RequestInit) => Promise<Response>;
      }>;
      methods: unknown[];
    };
  };

  const loaded = await plugin.auth.loader(
    async () => ({
      type: "oauth",
      access: options.accessToken,
      refresh: options.refreshToken,
      // Far beyond any refresh margin: the offline run must not attempt one.
      expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    }),
    { models: {} },
  );

  const pluginFetch = loaded.fetch;
  if (typeof pluginFetch !== "function") {
    throw new Error("reference plugin loader returned no fetch wrapper");
  }

  lane.fetch = async (input, init) => {
    const saved = globalThis.fetch;
    globalThis.fetch = options.terminal as typeof globalThis.fetch;
    try {
      return await pluginFetch(input, init);
    } finally {
      globalThis.fetch = saved;
    }
  };

  return lane;
}

export async function referenceProvenance(): Promise<Record<string, unknown>> {
  const { readFile } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);

  const nodePath = await import("node:path");

  // Some packages (notably @anthropic-ai/sdk) do not expose ./package.json in
  // their exports map, so fall back to walking up from the resolved entry.
  const resolveManifest = (specifier: string): string => {
    try {
      return require.resolve(`${specifier}/package.json`);
    } catch {
      let dir = nodePath.dirname(require.resolve(specifier));
      for (let depth = 0; depth < 8; depth += 1) {
        const candidate = nodePath.join(dir, "package.json");
        if (candidate.includes(`node_modules${nodePath.sep}`)) {
          try {
            require(candidate);
            return candidate;
          } catch {
            // keep walking
          }
        }
        const parent = nodePath.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      throw new Error(`cannot resolve manifest for ${specifier}`);
    }
  };

  const read = async (specifier: string) => {
    try {
      const path = resolveManifest(specifier);
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as {
        name?: string;
        version?: string;
        gitHead?: string;
      };
      return {
        name: parsed.name ?? specifier,
        version: parsed.version ?? null,
        gitHead: parsed.gitHead ?? null,
      };
    } catch {
      return { name: specifier, version: null, gitHead: null };
    }
  };

  return {
    reference: await read("@ex-machina/opencode-anthropic-auth"),
    langchainAnthropic: await read("@langchain/anthropic"),
    langchainCore: await read("@langchain/core"),
    anthropicSdk: await read("@anthropic-ai/sdk"),
    zod: await read("zod"),
  };
}
