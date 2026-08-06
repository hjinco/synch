import { z } from "zod";

const optionalNonBlankString = z.preprocess(
	(value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
	z.string().trim().min(1).optional(),
);

const nodeEnvSchema = z.object({
	DATA_DIR: optionalNonBlankString.default("./data"),
	PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
	HOST: optionalNonBlankString.default("0.0.0.0"),
	PUBLIC_URL: optionalNonBlankString,
	CORS_ORIGIN: optionalNonBlankString,
	BETTER_AUTH_SECRET: z.string().trim().min(1, "BETTER_AUTH_SECRET is required"),
	AUTH_ALLOWED_EMAILS: z.string().trim().min(1, "AUTH_ALLOWED_EMAILS is required"),
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
	dataDir: string;
	publicUrl: string;
	corsOrigin?: string;
	betterAuthSecret: string;
	authAllowedEmails: string;
	syncTokenSecret: string;
	syncTokenTtlSeconds?: number;
	blob: NodeBlobConfig;
};

export function parseNodeServerConfig(
	input: Readonly<Record<string, string | undefined>>,
): NodeServerConfig {
	const env = nodeEnvSchema.parse(input);
	const publicUrl = parseUrl("PUBLIC_URL", env.PUBLIC_URL ?? `http://localhost:${env.PORT}`);
	const corsOrigin = env.CORS_ORIGIN
		? new URL(parseUrl("CORS_ORIGIN", env.CORS_ORIGIN)).origin
		: undefined;

	return {
		host: env.HOST,
		port: env.PORT,
		dataDir: env.DATA_DIR,
		publicUrl,
		corsOrigin,
		betterAuthSecret: env.BETTER_AUTH_SECRET,
		authAllowedEmails: env.AUTH_ALLOWED_EMAILS,
		syncTokenSecret: env.SYNC_TOKEN_SECRET,
		syncTokenTtlSeconds: env.SYNC_TOKEN_TTL_SECONDS,
		blob: parseBlobConfig(env),
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
