import type { AppDb } from "../../db/client";
import {
	createBetterAuth,
	type AuthFeatureConfig,
	type AuthPlugin,
} from "../../auth/better-auth";
import type { AuthHttpHandler } from "../../auth/routes";
import {
	createBetterAuthSessionReader,
	type SessionReader,
} from "../../auth/session";

export type AuthFeature = {
	authHttpHandler: AuthHttpHandler;
	sessionReader: SessionReader;
};

export function createAuthFeature(
	db: AppDb,
	config: AuthFeatureConfig,
	plugins: AuthPlugin[] = [],
): AuthFeature {
	const auth = createBetterAuth(db, { ...config, plugins });

	return {
		authHttpHandler: (request) => auth.handler(request),
		sessionReader: createBetterAuthSessionReader(auth),
	};
}
