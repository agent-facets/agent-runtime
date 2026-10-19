// API outcomes shared by the services behind the browser API: an HTTP status with a contract-shaped body, and the
// error envelope every refusal uses.
import type { Acceptance, ErrorCode, ErrorEnvelope } from '@agent-runtime/contracts';

/** A complete API outcome: the HTTP status and the contract-shaped body. */
export type ApiResult<T = unknown> = { status: 200 | 202; body: T } | { status: number; body: ErrorEnvelope };

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  json_required: 400,
  request_too_large: 400,
  goal_required: 400,
  goal_too_long: 400,
  goal_not_storable: 400,
  command_arguments_invalid: 400,
  answer_invalid: 400,
  credential_in_input: 400,
  invalid_cursor: 400,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  request_conflict: 409,
  answer_conflict: 409,
  not_answerable: 409,
  continuation_unavailable: 409,
  provider_unavailable: 409,
  workspace_unavailable: 409,
  cancellation_conflict: 409,
  run_finished: 409,
  cursor_ahead: 409,
  capability_selection_changed: 409,
  capability_unavailable: 409,
  cannot_verify: 503,
  screening_unavailable: 503,
  storage_unavailable: 503,
  acceptance_unknown: 503,
  capabilities_unavailable: 503,
  mcp_server_unavailable: 503,
  service_unavailable: 503,
};

export function refusal(
  code: ErrorCode,
  message: string,
  details: {
    acceptance?: Acceptance;
    retryable?: boolean;
    runId?: string;
    questionId?: string;
    /** A safe public reference to the affected contribution or tool. */
    subject?: string;
    status?: number;
  } = {},
): { status: number; body: ErrorEnvelope } {
  const status = details.status ?? STATUS[code];
  return {
    status,
    body: {
      error: {
        code,
        message,
        ...(details.runId === undefined ? {} : { runId: details.runId }),
        ...(details.questionId === undefined ? {} : { questionId: details.questionId }),
        ...(details.subject === undefined ? {} : { subject: details.subject }),
        retryable: details.retryable ?? status === 503,
        acceptance: details.acceptance ?? 'not_accepted',
      },
    },
  };
}
