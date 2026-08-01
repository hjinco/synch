import { Hono } from "hono";
import { cors } from "hono/cors";

import { registerAuthRoutes, type Auth } from "./auth";
import { registerBillingRoutes } from "./billing/routes";
import type { BillingService } from "./billing/service";
import { onError } from "./errors";
import { registerHealthRoutes } from "./health/routes";
import { registerPluginVersionRoutes } from "./plugin-version/routes";
import type { SubscriptionPolicyReader } from "./subscription/policy-service";
import { registerSyncAccessRoutes } from "./sync/access/routes";
import type { SyncService } from "./sync/access/service";
import type { SyncTokenService } from "./sync/access/token-service";
import { registerBlobRoutes } from "./sync/blob/routes";
import type { BlobStorage } from "./sync/blob/storage";
import { registerCoordinatorProxyRoutes } from "./sync/coordinator/proxy-routes";
import type { CoordinatorProxyRepository } from "./sync/coordinator/proxy-repository";
import { registerVaultRoutes } from "./vault/routes";
import type { VaultService } from "./vault/service";

export type AppDependencies = {
	auth: Auth;
	syncService: SyncService;
	syncTokenService: SyncTokenService;
	blobRepository: BlobStorage;
	coordinatorProxyRepository: CoordinatorProxyRepository;
	vaultService: VaultService;
	subscriptionPolicyService: SubscriptionPolicyReader;
	billingService: BillingService;
};

export type AppConfig = {
	publicOrigin: string;
	corsOrigin: string;
	billingEnabled: boolean;
};

export type { VaultRecord } from "./vault/types";

export function createApp(deps: AppDependencies, config: AppConfig): Hono {
	const app = new Hono();

	app.use(
		"*",
		cors({
			origin: config.corsOrigin,
			credentials: true,
		}),
	);

	registerAuthRoutes(app, deps.auth);
	registerHealthRoutes(app);
	registerPluginVersionRoutes(app);
	registerSyncAccessRoutes(app, deps);
	registerVaultRoutes(app, deps);
	if (config.billingEnabled) {
		registerBillingRoutes(app, deps);
	}
	registerBlobRoutes(app, deps);
	registerCoordinatorProxyRoutes(app, deps);

	app.notFound((c) =>
		c.json(
			{
				error: "not_found",
				message: "unknown route",
			},
			404,
		),
	);

	app.onError(onError);

	return app;
}
