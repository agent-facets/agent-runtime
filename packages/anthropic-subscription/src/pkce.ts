// Derived from @ex-machina/opencode-anthropic-auth src/pkce.ts (revision 156cb66); see PROVENANCE.md.

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** A 64-byte random verifier and its S256 challenge. */
export async function generatePkce(): Promise<Pkce> {
  const buffer = new Uint8Array(64);
  crypto.getRandomValues(buffer);
  const verifier = base64UrlEncode(buffer);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)), method: 'S256' };
}
