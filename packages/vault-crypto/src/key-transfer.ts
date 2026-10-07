import { decodeBase64, encodeBase64, toArrayBuffer } from "./bytes";

export type KeyTransferContext = {
  requestId: string;
  vaultId: string;
  userId: string;
  accessVersion: number;
};
export type KeyTransferEnvelope = {
  version: 1;
  algorithm: "rsa-oaep-sha256";
  ciphertext: string;
};
const algorithm = { name: "RSA-OAEP", hash: "SHA-256" } as const;

/** Request-scoped receiver keys. The private key never leaves the receiving device. */
export async function createKeyTransferReceiver(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const keys = await crypto.subtle.generateKey(
    {
      ...algorithm,
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["encrypt", "decrypt"],
  );
  if (!("publicKey" in keys) || !("privateKey" in keys))
    throw new Error("Receiver key generation failed");
  return {
    publicKey: encodeBase64(
      new Uint8Array(
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Cloudflare's exportKey type also includes JsonWebKey for binary formats.
        (await crypto.subtle.exportKey("spki", keys.publicKey)) as ArrayBuffer,
      ),
    ),
    privateKey: encodeBase64(
      new Uint8Array(
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Cloudflare's exportKey type also includes JsonWebKey for binary formats.
        (await crypto.subtle.exportKey(
          "pkcs8",
          keys.privateKey,
        )) as ArrayBuffer,
      ),
    ),
  };
}

export async function validateKeyTransferPublicKey(
  publicKey: string,
): Promise<void> {
  await importReceiver(publicKey);
}

async function importReceiver(publicKey: string): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey(
    "spki",
    toArrayBuffer(decodeBase64(publicKey)),
    algorithm,
    false,
    ["encrypt"],
  );
  const params = key.algorithm as unknown as {
    modulusLength: number;
    publicExponent: Uint8Array;
  };
  if (
    params.modulusLength !== 3072 ||
    Array.from(params.publicExponent).join(",") !== "1,0,1"
  )
    throw new Error("Unsupported receiver key");
  return key;
}

function label(context: KeyTransferContext): Uint8Array<ArrayBuffer> {
  if (
    !context.requestId ||
    !context.vaultId ||
    !context.userId ||
    !Number.isSafeInteger(context.accessVersion) ||
    context.accessVersion < 1
  )
    throw new Error("Invalid transfer context");
  return new Uint8Array(
    new TextEncoder().encode(
      JSON.stringify([
        "synch.vault-key-transfer",
        1,
        context.requestId,
        context.vaultId,
        context.userId,
        context.accessVersion,
      ]),
    ),
  );
}

/** Compare this full code with the recipient through a separate trusted channel. */
export async function keyTransferVerificationCode(
  publicKey: string,
  context: KeyTransferContext,
): Promise<string> {
  await importReceiver(publicKey);
  const bytes = decodeBase64(publicKey);
  const binding = label(context);
  const data = new Uint8Array(binding.length + bytes.length);
  data.set(binding);
  data.set(bytes, binding.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  // 128 bits, grouped for manual comparison. Context and recipient key are bound.
  return Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .match(/.{4}/g)!
    .join("-");
}

export async function encryptVaultKeyForReceiver(
  key: Uint8Array,
  publicKey: string,
  context: KeyTransferContext,
): Promise<KeyTransferEnvelope> {
  if (key.byteLength !== 32) throw new Error("Invalid vault key length");
  const ciphertext = await crypto.subtle.encrypt(
    { name: "RSA-OAEP", label: label(context) },
    await importReceiver(publicKey),
    toArrayBuffer(key),
  );
  return {
    version: 1,
    algorithm: "rsa-oaep-sha256",
    ciphertext: encodeBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptTransferredVaultKey(
  envelope: KeyTransferEnvelope,
  privateKey: string,
  context: KeyTransferContext,
): Promise<Uint8Array> {
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== "rsa-oaep-sha256" ||
    decodeBase64(envelope.ciphertext).length !== 384
  )
    throw new Error("Invalid key transfer envelope");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(decodeBase64(privateKey)),
    algorithm,
    false,
    ["decrypt"],
  );
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "RSA-OAEP", label: label(context) },
      key,
      toArrayBuffer(decodeBase64(envelope.ciphertext)),
    ),
  );
  if (plaintext.byteLength !== 32)
    throw new Error("Invalid transferred key length");
  return plaintext;
}
