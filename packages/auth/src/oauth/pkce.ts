// Adapted from pi (https://github.com/badlogic/pi-mono), packages/ai/src/auth/oauth/pkce.ts. MIT License.

/** Encode bytes as unpadded base64url. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Generate a PKCE code verifier and its S256 challenge (RFC 7636). */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}
