import { DEFAULT_PORT } from './server.ts';

export interface RuntimeConfig {
  port: number;
  databaseUrl: string | undefined;
}

export function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT;
  if (!/^\d+$/.test(value)) throw new Error('RUNTIME_PORT must be a decimal port number');
  const port = Number(value);
  if (port < 1 || port > 65_535) throw new Error('RUNTIME_PORT must be between 1 and 65535');
  return port;
}

export function loadConfig(env: Record<string, string | undefined>): RuntimeConfig {
  const databaseUrl = env.DATABASE_URL === '' ? undefined : env.DATABASE_URL;
  return { port: parsePort(env.RUNTIME_PORT), databaseUrl };
}
