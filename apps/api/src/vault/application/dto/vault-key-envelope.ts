import { z } from "zod";

import type { VaultKeyEnvelope } from "../../domain/types";

/**
 * Wire contract for vault key envelopes shared with the Obsidian plugin.
 * These are E2EE security parameters: they are validated verbatim so a
 * plugin-encrypted envelope can only ever be stored, never transformed.
 * Changing any value requires a coordinated envelope version bump.
 */
export const VAULT_KEY_ENVELOPE_VERSION = 1;
export const VAULT_KEY_ENVELOPE_KEY_VERSION = 1;
export const ARGON2_MEMORY_KIB = 65_536;
export const ARGON2_ITERATIONS = 3;
export const ARGON2_PARALLELISM = 1;
export const ARGON2_SALT_BYTES = 16;
export const AES_GCM_NONCE_BYTES = 12;
export const WRAPPED_VAULT_KEY_BYTES = 48;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function base64Bytes(byteLength: number): z.ZodString {
	const encodedLength = Math.ceil(byteLength / 3) * 4;

	return z
		.string()
		.length(encodedLength)
		.regex(BASE64_PATTERN)
		.refine((value) => base64DecodedLength(value) === byteLength, {
			message: `must decode to ${byteLength} bytes`,
		});
}

function base64DecodedLength(value: string): number | null {
	try {
		return atob(value).length;
	} catch {
		return null;
	}
}

export const vaultKeyEnvelopeSchema: z.ZodType<VaultKeyEnvelope> = z.object({
	version: z.literal(VAULT_KEY_ENVELOPE_VERSION),
	keyVersion: z.literal(VAULT_KEY_ENVELOPE_KEY_VERSION),
	kdf: z.object({
		name: z.literal("argon2id"),
		memoryKiB: z.literal(ARGON2_MEMORY_KIB),
		iterations: z.literal(ARGON2_ITERATIONS),
		parallelism: z.literal(ARGON2_PARALLELISM),
		salt: base64Bytes(ARGON2_SALT_BYTES),
	}),
	wrap: z.object({
		algorithm: z.literal("aes-256-gcm"),
		nonce: base64Bytes(AES_GCM_NONCE_BYTES),
		ciphertext: base64Bytes(WRAPPED_VAULT_KEY_BYTES),
	}),
});
