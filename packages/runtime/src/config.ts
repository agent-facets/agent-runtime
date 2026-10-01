import { ConfigError, type OperatorConfig, parseOperatorConfig } from './config/operator.ts';
import { parsePublicOrigin } from './request-policy.ts';
import { DEFAULT_PORT } from './server.ts';

export const DEFAULT_STATE_DIR = '/var/lib/agent-runtime';

export interface RuntimeConfig {
  port: number;
  databaseUrl: string | undefined;
  /** Private runtime state; provider credentials live beneath it. */
  stateDir: string;
  /** Operator configuration file, when agent execution is configured. */
  configFile: string | undefined;
  /** Parsed operator configuration; undefined leaves agent execution unconfigured. */
  operator?: OperatorConfig;
  /** The console's browser-visible origin behind Tailscale Serve; undefined accepts loopback requests only. */
  publicOrigin?: string;
}

export function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT;
  if (!/^\d+$/.test(value)) throw new ConfigError('RUNTIME_PORT must be a decimal port number');
  const port = Number(value);
  if (port < 1 || port > 65_535) throw new ConfigError('RUNTIME_PORT must be between 1 and 65535');
  return port;
}

function absoluteSetting(name: string, value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!value.startsWith('/') || value.includes('\0')) throw new ConfigError(`${name} must be an absolute path`);
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

export function loadConfig(env: Record<string, string | undefined>): RuntimeConfig {
  const databaseUrl = env.DATABASE_URL === '' ? undefined : env.DATABASE_URL;
  let publicOrigin: string | undefined;
  if (env.RUNTIME_PUBLIC_ORIGIN !== undefined && env.RUNTIME_PUBLIC_ORIGIN !== '') {
    publicOrigin = parsePublicOrigin(env.RUNTIME_PUBLIC_ORIGIN);
    if (publicOrigin === undefined) {
      throw new ConfigError(
        'RUNTIME_PUBLIC_ORIGIN must be an HTTPS origin such as https://agent-runtime.example.ts.net',
      );
    }
  }
  return {
    port: parsePort(env.RUNTIME_PORT),
    databaseUrl,
    stateDir: absoluteSetting('RUNTIME_STATE_DIR', env.RUNTIME_STATE_DIR) ?? DEFAULT_STATE_DIR,
    configFile: absoluteSetting('RUNTIME_CONFIG_FILE', env.RUNTIME_CONFIG_FILE),
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
  };
}

/** Reads and validates the operator configuration named by RUNTIME_CONFIG_FILE, if any. */
export async function withOperatorConfig(config: RuntimeConfig): Promise<RuntimeConfig> {
  if (config.configFile === undefined) return config;
  const file = Bun.file(config.configFile);
  let source: string;
  try {
    source = await file.text();
  } catch {
    throw new ConfigError('RUNTIME_CONFIG_FILE could not be read');
  }
  return {
    ...config,
    operator: parseOperatorConfig(source, { stateDir: config.stateDir, configFile: config.configFile }),
  };
}
