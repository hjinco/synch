/// <reference path="../types/hash-wasm-argon2.d.ts" />

import type { RemoteVaultKeyDerivationMetadata } from "./types";
import { decodeBase64, encodeBase64, randomBytes, toArrayBuffer } from "../utils/bytes";

const ARGON2_SALT_BYTES = 16;
const WRAP_KEY_BYTES = 32;

type Argon2idParams = Pick<
  RemoteVaultKeyDerivationMetadata,
  "memoryKiB" | "iterations" | "parallelism"
>;

type Argon2idParamOverrides = Partial<Argon2idParams>;

const DEFAULT_ARGON2ID_PARAMS: Argon2idParams = {
  memoryKiB: 65_536,
  iterations: 3,
  parallelism: 1,
};

export function createArgon2idMetadata(
  overrides: Argon2idParamOverrides = {},
): RemoteVaultKeyDerivationMetadata {
  return {
    name: "argon2id",
    memoryKiB: overrides.memoryKiB ?? DEFAULT_ARGON2ID_PARAMS.memoryKiB,
    iterations: overrides.iterations ?? DEFAULT_ARGON2ID_PARAMS.iterations,
    parallelism: overrides.parallelism ?? DEFAULT_ARGON2ID_PARAMS.parallelism,
    salt: encodeBase64(randomBytes(ARGON2_SALT_BYTES)),
  };
}

export async function deriveWrapKey(
  password: string,
  metadata: RemoteVaultKeyDerivationMetadata,
): Promise<CryptoKey> {
  if (metadata.name !== "argon2id") {
    throw new Error(`unsupported KDF: ${metadata.name}`);
  }

  const imported = (await import("hash-wasm/dist/argon2.umd.min.js")) as {
    default?: { argon2id?: typeof import("hash-wasm").argon2id };
    "module.exports"?: { argon2id?: typeof import("hash-wasm").argon2id };
  };
  const argon2id =
    imported.default?.argon2id ?? imported["module.exports"]?.argon2id;
  if (!argon2id) {
    throw new Error("argon2id module failed to load");
  }
  const derivedBytes = await argon2id({
    password: new TextEncoder().encode(password),
    salt: decodeBase64(metadata.salt),
    iterations: metadata.iterations,
    parallelism: metadata.parallelism,
    memorySize: metadata.memoryKiB,
    hashLength: WRAP_KEY_BYTES,
    outputType: "binary",
  });

  return await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(derivedBytes),
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"],
  );
}
