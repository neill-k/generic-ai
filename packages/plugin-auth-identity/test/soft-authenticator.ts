import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

/**
 * A software WebAuthn authenticator for tests. It produces ES256 credentials
 * with "none" attestation, which is what the owner auth plugin requests.
 */

type CborValue = number | string | Uint8Array | ReadonlyMap<CborValue, CborValue>;

function encodeHead(major: number, length: number): Uint8Array {
  if (length < 24) {
    return Uint8Array.of((major << 5) | length);
  }
  if (length < 0x100) {
    return Uint8Array.of((major << 5) | 24, length);
  }
  if (length < 0x10000) {
    return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
  }
  throw new Error("Test CBOR encoder only supports lengths below 65536.");
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
}

function encodeCbor(value: CborValue): Uint8Array {
  if (typeof value === "number") {
    return value >= 0 ? encodeHead(0, value) : encodeHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat(encodeHead(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) {
    return concat(encodeHead(2, value.length), value);
  }
  const parts: Uint8Array[] = [encodeHead(5, value.size)];
  for (const [key, entry] of value) {
    parts.push(encodeCbor(key), encodeCbor(entry));
  }
  return concat(...parts);
}

const b64u = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes: Uint8Array | string): Buffer => createHash("sha256").update(bytes).digest();

export interface SoftAuthenticatorOptions {
  readonly origin: string;
  readonly rpId?: string;
  readonly userVerified?: boolean;
}

export function createSoftAuthenticator(options: SoftAuthenticatorOptions) {
  const rpId = options.rpId ?? new URL(options.origin).hostname;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = new Uint8Array(randomBytes(16));
  let signCount = 0;
  let userHandle: string | undefined;
  const flags = 0x01 | (options.userVerified === false ? 0 : 0x04);

  const cosePublicKey = encodeCbor(
    new Map<CborValue, CborValue>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x as string, "base64url"))],
      [-3, new Uint8Array(Buffer.from(jwk.y as string, "base64url"))],
    ]),
  );

  const clientData = (type: string, challenge: string, origin: string) =>
    new Uint8Array(
      Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8"),
    );

  const counter = (value: number) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value);
    return new Uint8Array(buffer);
  };

  return {
    credentialId: b64u(credentialId),

    register(
      creationOptions: { readonly challenge: string; readonly user: { readonly id: string } },
      origin: string = options.origin,
    ) {
      userHandle = creationOptions.user.id;
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authData = concat(
        sha256(rpId),
        Uint8Array.of(flags | 0x40),
        counter(signCount),
        new Uint8Array(16),
        new Uint8Array(idLength),
        credentialId,
        cosePublicKey,
      );
      const attestationObject = encodeCbor(
        new Map<CborValue, CborValue>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: "public-key" as const,
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64u(clientData("webauthn.create", creationOptions.challenge, origin)),
          attestationObject: b64u(attestationObject),
          transports: ["internal" as const],
        },
      };
    },

    authenticate(requestOptions: { readonly challenge: string }, origin: string = options.origin) {
      signCount += 1;
      const authData = concat(sha256(rpId), Uint8Array.of(flags), counter(signCount));
      const clientDataJSON = clientData("webauthn.get", requestOptions.challenge, origin);
      const signature = sign("sha256", concat(authData, sha256(clientDataJSON)), privateKey);
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: "public-key" as const,
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64u(clientDataJSON),
          authenticatorData: b64u(authData),
          signature: b64u(signature),
          ...(userHandle === undefined ? {} : { userHandle }),
        },
      };
    },
  };
}
