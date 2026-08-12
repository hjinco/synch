import { describe, expect, it } from "vitest";

import { parseNodeServerConfig } from "./node";

const requiredEnv = {
	BETTER_AUTH_SECRET: "auth-secret",
	AUTH_ALLOWED_EMAILS: "owner@example.com",
	SYNC_TOKEN_SECRET: "sync-secret",
};

describe("Node server config", () => {
	it("applies Node server defaults", () => {
		const config = parseNodeServerConfig(requiredEnv);

		expect(config).toMatchObject({
			host: "0.0.0.0",
			port: 8787,
			dataDir: "./data",
			publicUrl: "http://localhost:8787",
			blob: { kind: "disk", directory: "./data/blobs" },
		});
	});

	it("validates and returns an S3 configuration", () => {
		const config = parseNodeServerConfig({
			...requiredEnv,
			BLOB_STORAGE: "S3",
			S3_ENDPOINT: "https://storage.example.com",
			S3_BUCKET: "synch",
			S3_ACCESS_KEY_ID: "access-key",
			S3_SECRET_ACCESS_KEY: "secret-key",
		});

		expect(config.blob).toEqual({
			kind: "s3",
			endpoint: "https://storage.example.com",
			bucket: "synch",
			region: undefined,
			accessKeyId: "access-key",
			secretAccessKey: "secret-key",
		});
	});

	it("rejects invalid ports and incomplete S3 settings before startup", () => {
		expect(() => parseNodeServerConfig({ ...requiredEnv, PORT: "70000" })).toThrow();
		expect(() =>
			parseNodeServerConfig({ ...requiredEnv, BLOB_STORAGE: "s3" }),
		).toThrow();
	});
});
