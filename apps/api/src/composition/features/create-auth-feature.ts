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
		authHttpHandler: (request) => {
      // Synch's endpoints enforce vault assignments, plan limits and revocation.
      // Internal Better Auth API calls (e.g. personal organization creation) remain available.
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return Promise.resolve(Response.json({ error: "invalid_path" }, { status: 400 })); }
      if (pathname.startsWith("/api/auth/organization/") && !(request.method === "GET" && pathname === "/api/auth/organization/list")) {
        return Promise.resolve(Response.json({ error: "use_organization_api", message: "Use the Synch organization management API" }, { status: 403 }));
      }
      return auth.handler(request);
    },
		sessionReader: createBetterAuthSessionReader(auth),
	};
}
