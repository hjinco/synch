import { z } from "zod";

import { parseOidcProviderConfig, type OidcProviderConfig } from "../auth/policies/oidc";
import { requiresSignUpAllowlist } from "../auth/policies/sign-up-allowlist";
import { capabilitiesFor, NODE_COMMUNITY_PROFILE } from "./deployment-profile";

const optionalNonBlankString = z.preprocess(
	(value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
	z.string().trim().min(1).optional(),
);

const nodeCapabilities = capabilitiesFor(NODE_COMMUNITY_PROFILE);

const baseNodeEnvSchema = z.object({
	DATA_DIR: optionalNonBlankString.default("./data"),
	PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
	// Keep uploads below the coordinator's 30-minute staged-blob GC grace.
	REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(25 * 60_000).default(300_000),
	HOST: optionalNonBlankString.default("0.0.0.0"),
	PUBLIC_URL: optionalNonBlankString,
	CORS_ORIGIN: optionalNonBlankString,
	BETTER_AUTH_SECRET: z.string().trim().min(1, "BETTER_AUTH_SECRET is required"),
	GOOGLE_CLIENT_ID: optionalNonBlankString,
	GOOGLE_CLIENT_SECRET: optionalNonBlankString,
	GITHUB_CLIENT_ID: optionalNonBlankString,
	GITHUB_CLIENT_SECRET: optionalNonBlankString,
	AUTH_ALLOWED_EMAILS: optionalNonBlankString,
	AUTH_EMAIL_PASSWORD: z.enum(["enabled", "disabled"]).default("enabled"),
	SYNC_TOKEN_SECRET: z.string().trim().min(1, "SYNC_TOKEN_SECRET is required"),
	SYNC_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().optional(),
	BLOB_STORAGE: z.preprocess(
		(value) => (typeof value === "string" ? value.toLowerCase() : value),
		z.enum(["disk", "s3"]).default("disk"),
	),
	BLOB_DISK_DIR: optionalNonBlankString,
	S3_ENDPOINT: optionalNonBlankString,
	S3_BUCKET: optionalNonBlankString,
	S3_REGION: optionalNonBlankString,
	S3_ACCESS_KEY_ID: optionalNonBlankString,
	S3_SECRET_ACCESS_KEY: optionalNonBlankString,
	OIDC_DISCOVERY_URL: optionalNonBlankString,
	OIDC_CLIENT_ID: optionalNonBlankString,
	OIDC_CLIENT_SECRET: optionalNonBlankString,
	OIDC_PROVIDER_NAME: optionalNonBlankString,
	OIDC_SCOPES: optionalNonBlankString,
	OIDC_ACCOUNT_ISSUER: optionalNonBlankString,
});

// The allowlist is the only gate on password sign-up and cannot prove
// whoever submits an address controls that inbox, so it must stay mandatory
// wherever password sign-up is reachable. It becomes optional only once
// AUTH_EMAIL_PASSWORD=disabled removes password sign-up entirely.
const nodeEnvSchema = baseNodeEnvSchema.superRefine((env, ctx) => {
	if (
		requiresSignUpAllowlist(nodeCapabilities, env.AUTH_EMAIL_PASSWORD) &&
		!env.AUTH_ALLOWED_EMAILS
	) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["AUTH_ALLOWED_EMAILS"],
			message: "AUTH_ALLOWED_EMAILS is required",
		});
	}
});

export type NodeBlobConfig =
	| { kind: "disk"; directory: string }
	| {
			kind: "s3";
			endpoint: string;
			bucket: string;
			region?: string;
			accessKeyId: string;
			secretAccessKey: string;
	  };

export type NodeServerConfig = {
	host: string;
	port: number;
	requestTimeoutMs: number;
	dataDir: string;
	publicUrl: string;
	corsOrigin?: string;
	betterAuthSecret: string;
	authAllowedEmails?: string;
	emailAndPassword: "enabled" | "disabled";
	googleClientId?: string;
	googleClientSecret?: string;
	githubClientId?: string;
	githubClientSecret?: string;
	syncTokenSecret: string;
	syncTokenTtlSeconds?: number;
	blob: NodeBlobConfig;
	oidc?: OidcProviderConfig;
};

export function parseNodeServerConfig(
	input: Readonly<Record<string, string | undefined>>,
): NodeServerConfig {
	const env = nodeEnvSchema.parse(input);
	const publicUrl = parseUrl("PUBLIC_URL", env.PUBLIC_URL ?? `http://localhost:${env.PORT}`);
	const corsOrigin = env.CORS_ORIGIN
		? new URL(parseUrl("CORS_ORIGIN", env.CORS_ORIGIN)).origin
		: undefined;

	const oidc = parseOidcProviderConfig({
		discoveryUrl: env.OIDC_DISCOVERY_URL,
		clientId: env.OIDC_CLIENT_ID,
		clientSecret: env.OIDC_CLIENT_SECRET,
		displayName: env.OIDC_PROVIDER_NAME,
		scopes: env.OIDC_SCOPES,
		accountIssuer: env.OIDC_ACCOUNT_ISSUER,
	});

	return {
		host: env.HOST,
		port: env.PORT,
		requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
		dataDir: env.DATA_DIR,
		publicUrl,
		corsOrigin,
		betterAuthSecret: env.BETTER_AUTH_SECRET,
		// Only absent when AUTH_EMAIL_PASSWORD=disabled (enforced above), in which
		// case there is no password sign-up for an allowlist to gate. Left as
		// `undefined` rather than "" so "not configured" stays distinguishable
		// from "configured but empty".
		authAllowedEmails: env.AUTH_ALLOWED_EMAILS,
		googleClientId: env.GOOGLE_CLIENT_ID,
		googleClientSecret: env.GOOGLE_CLIENT_SECRET,
		githubClientId: env.GITHUB_CLIENT_ID,
		githubClientSecret: env.GITHUB_CLIENT_SECRET,
		emailAndPassword: env.AUTH_EMAIL_PASSWORD,
		syncTokenSecret: env.SYNC_TOKEN_SECRET,
		syncTokenTtlSeconds: env.SYNC_TOKEN_TTL_SECONDS,
		blob: parseBlobConfig(env),
		oidc,
	};
}

function parseBlobConfig(env: z.infer<typeof nodeEnvSchema>): NodeBlobConfig {
	if (env.BLOB_STORAGE === "disk") {
		return {
			kind: "disk",
			directory: env.BLOB_DISK_DIR ?? `${env.DATA_DIR}/blobs`,
		};
	}

	return {
		kind: "s3",
		endpoint: requireValue("S3_ENDPOINT", env.S3_ENDPOINT),
		bucket: requireValue("S3_BUCKET", env.S3_BUCKET),
		region: env.S3_REGION,
		accessKeyId: requireValue("S3_ACCESS_KEY_ID", env.S3_ACCESS_KEY_ID),
		secretAccessKey: requireValue("S3_SECRET_ACCESS_KEY", env.S3_SECRET_ACCESS_KEY),
	};
}

function requireValue(name: string, value: string | undefined): string {
	if (!value) {
		throw new Error(`${name} is required when BLOB_STORAGE=s3`);
	}
	return value;
}

function parseUrl(name: string, value: string): string {
	try {
		new URL(value);
		return value;
	} catch {
		throw new Error(`${name} must be a valid URL`);
	}
}
