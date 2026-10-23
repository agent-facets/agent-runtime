// Derived from @ex-machina/opencode-anthropic-auth src/cch.ts (revision 156cb66); see PROVENANCE.md.
// The billing block is derived from the text of the first user message; the version and entrypoint come from the
// explicit profile rather than module constants.
import { createHash } from 'node:crypto';
import type { SubscriptionProfile } from './profile.ts';

const CCH_SALT = '59cf53e54c78';
const CCH_POSITIONS = [4, 7, 20];

export interface WireMessage {
  role?: unknown;
  content?: unknown;
}

/** Text of the first user message's first text block, or '' when there is none. */
export function firstUserMessageText(messages: readonly WireMessage[]): string {
  const message = messages.find((candidate) => candidate?.role === 'user');
  if (!message) return '';
  const { content } = message;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const block = content.find(
      (candidate) => candidate !== null && typeof candidate === 'object' && candidate.type === 'text',
    );
    if (typeof block?.text === 'string' && block.text) return block.text;
  }
  return '';
}

export function computeCch(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 5);
}

export function computeVersionSuffix(text: string, version: string): string {
  const sampled = CCH_POSITIONS.map((index) => text[index] || '0').join('');
  return createHash('sha256').update(`${CCH_SALT}${sampled}${version}`).digest('hex').slice(0, 3);
}

export const BILLING_PREFIX = 'x-anthropic-billing-header:';

/** The billing system block's text for this conversation under this profile. */
export function billingText(messages: readonly WireMessage[], profile: SubscriptionProfile): string {
  const text = firstUserMessageText(messages);
  return (
    `${BILLING_PREFIX} ` +
    `cc_version=${profile.clientVersion}.${computeVersionSuffix(text, profile.clientVersion)}; ` +
    `cc_entrypoint=${profile.entrypoint}; ` +
    `cch=${computeCch(text)};`
  );
}
