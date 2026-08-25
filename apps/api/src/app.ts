import { Hono } from "hono";
import { cors } from "hono/cors";

import type { AuthHttpHandler } from "./auth/routes";
import { registerAuthRoutes } from "./auth/routes";
import type { SessionReader } from "./auth/session";
import { registerBillingRoutes } from "./billing/adapters/inbound/http/routes";
import type { BillingService } from "./billing/application";
import { mapBillingApplicationError } from "./billing/adapters/inbound/http/error-mapper";
import { onError } from "./errors";
import { registerPluginVersionRoutes } from "./plugin-version/routes";
import type { SubscriptionPolicyReader } from "./subscription/application";
import type { IssueSyncToken } from "./sync-access/application";
import { mapSyncAccessApplicationError } from "./sync-access/adapters/inbound/http/error-mapper";
import { registerSyncAccessRoutes } from "./sync-access/adapters/inbound/http/routes";
import type { DownloadBlob, UploadBlob } from "./sync-blob-transfer/application";
import { mapBlobTransferApplicationError } from "./sync-blob-transfer/adapters/inbound/http/error-mapper";
import { registerBlobTransferRoutes } from "./sync-blob-transfer/adapters/inbound/http/routes";
import { registerCoordinatorAdminRoutes } from "./sync-coordinator/adapters/inbound/http/admin-routes";
import {
	registerCoordinatorProxyRoutes,
	type CoordinatorRequestTokenVerifier,
} from "./sync-coordinator/adapters/inbound/http/proxy-routes";
import type { CoordinatorProxyRepository } from "./sync-coordinator/adapters/outbound/durable-object-rpc/coordinator-proxy-repository";
import { registerVaultRoutes } from "./vault/adapters/inbound/http/routes";
import { mapVaultApplicationError } from "./vault/adapters/inbound/http/error-mapper";
import type { VaultService } from "./vault/application";

export type AppDependencies = {
	authHttpHandler: AuthHttpHandler;
	sessionReader: SessionReader;
	syncTokenIssuer: IssueSyncToken;
	syncTokenRequestVerifier: CoordinatorRequestTokenVerifier;
	uploadBlob: UploadBlob;
	downloadBlob: DownloadBlob;
	coordinatorProxyRepository: CoordinatorProxyRepository;
	vaultService: VaultService;
	subscriptionPolicyService: SubscriptionPolicyReader;
	billingService?: BillingService;
};

export type AppConfig = {
	corsOrigin: string;
	adminToken?: string;
};

export type { VaultRecord } from "./vault/application";

export function createApp(deps: AppDependencies, config: AppConfig): Hono {
	const app = new Hono();

	app.use(
		"*",
		cors({
			origin: config.corsOrigin,
			credentials: true,
		}),
	);

	registerAuthRoutes(app, deps.authHttpHandler);
	app.get("/health", (c) =>
		c.json({
			ok: true,
			service: "synch-api",
		}),
	);
	registerPluginVersionRoutes(app);
	registerSyncAccessRoutes(app, {
		syncTokenIssuer: deps.syncTokenIssuer,
		sessionReader: deps.sessionReader,
	});
	registerVaultRoutes(app, deps);
	if (deps.billingService) {
		registerBillingRoutes(app, {
			sessionReader: deps.sessionReader,
			billingService: deps.billingService,
		});
	}
	registerBlobTransferRoutes(app, {
		uploadBlob: deps.uploadBlob,
		downloadBlob: deps.downloadBlob,
	});
	registerCoordinatorProxyRoutes(app, {
		syncTokenVerifier: deps.syncTokenRequestVerifier,
		coordinatorProxyRepository: deps.coordinatorProxyRepository,
	});
	registerCoordinatorAdminRoutes(app, {
		coordinatorProxyRepository: deps.coordinatorProxyRepository,
		adminToken: config.adminToken,
	});

	app.notFound((c) =>
		c.json(
			{
				error: "not_found",
				message: "unknown route",
			},
			404,
		),
	);

	app.onError((error, c) =>
		mapSyncAccessApplicationError(error) ??
		mapBlobTransferApplicationError(error) ??
		mapVaultApplicationError(error) ??
		mapBillingApplicationError(error) ??
		onError(error, c),
	);

	return app;
}
