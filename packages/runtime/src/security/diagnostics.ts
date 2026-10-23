// The only way application diagnostics are written. A diagnostic is a flat, plain object of allowlisted fields
// with validated primitive values — never an Error, request, response, headers, body, arbitrary message or
// nested "details" bag. Anything else is replaced by a fixed rejection record that echoes nothing from the input,
// so a mistake in a caller cannot turn into a credential in a log.
import { z } from 'zod';

const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const diagnosticSchema = z.strictObject({
  event: code,
  reason: code.optional(),
  provider: z.enum(['anthropic', 'openai']).optional(),
  operation: z
    .enum(['startup', 'persistence', 'device_poll', 'credential_refresh', 'inference', 'tool', 'continuation', 'http'])
    .optional(),
  runId: z.uuid().optional(),
  attemptId: z.uuid().optional(),
  operationId: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  status: z.number().int().min(100).max(599).optional(),
  sqlState: z
    .string()
    .regex(/^[0-9A-Z]{5}$/)
    .optional(),
  durationMs: z.number().int().min(0).max(86_400_000).optional(),
  count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  retryAfterSeconds: z.number().int().min(0).max(604_800).optional(),
});

export type SafeDiagnostic = z.infer<typeof diagnosticSchema>;

const REJECTED = JSON.stringify({ event: 'diagnostic_rejected' });

function isPlainFlatObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  // Accessors (including a toJSON or toString defined as a property) could run arbitrary code or change output.
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) return false;
    if (key === 'toJSON' || key === 'toString') return false;
    const item = descriptor.value;
    if (item !== undefined && typeof item !== 'string' && typeof item !== 'number') return false;
  }
  return Object.getOwnPropertySymbols(value).length === 0;
}

/** Serializes a diagnostic as one JSON line, or the fixed rejection record. */
export function formatDiagnostic(value: unknown): string {
  if (!isPlainFlatObject(value)) return REJECTED;
  const parsed = diagnosticSchema.safeParse(value);
  return parsed.success ? JSON.stringify(parsed.data) : REJECTED;
}

export type DiagnosticSink = (line: string) => void;

export function diagnosticLogger(sink: DiagnosticSink): (diagnostic: SafeDiagnostic) => void {
  return (diagnostic) => sink(formatDiagnostic(diagnostic));
}
