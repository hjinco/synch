import type { BetterAuthPlugin } from "better-auth";

import type { AppDb } from "../../db/client";
import type { SessionReader } from "../../auth/application";
import type { AuthFeatureConfig } from "../../auth/application/dto/auth-config";
import { BetterAuthHttpHandler } from "../../auth/adapters/inbound/http/handler";
import type { AuthHttpHandler } from "../../auth/adapters/inbound/http/handler";
import { createBetterAuth } from "../../auth/adapters/outbound/better-auth";
import { BetterAuthSessionProvider } from "../../auth/adapters/outbound/better-auth-session-provider";
import { DrizzleAuthPersistence } from "../../auth/adapters/outbound/drizzle-auth-persistence";
import { ReadSessionUseCase } from "../../auth/application/use-cases/read-session";

export type AuthFeature = {
	authHttpHandler: AuthHttpHandler;
	sessionReader: SessionReader;
};

export function createAuthFeature(
	db: AppDb,
	config: AuthFeatureConfig,
	plugins: BetterAuthPlugin[] = [],
): AuthFeature {
	const auth = createBetterAuth(
		db,
		{ ...config, plugins },
		new DrizzleAuthPersistence(db),
	);
	const sessionProvider = new BetterAuthSessionProvider(auth);

	return {
		authHttpHandler: new BetterAuthHttpHandler(auth),
		sessionReader: new ReadSessionUseCase(sessionProvider),
	};
}
