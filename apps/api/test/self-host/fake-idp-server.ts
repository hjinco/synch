import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";

import type { FakeIdp } from "../helpers/fake-idp";

export type FakeIdpServer = {
	baseUrl: string;
	close(): Promise<void>;
};

/**
 * Reserves a free TCP port synchronously, same technique as
 * `test/self-host/e2e.test.ts`'s own `reserveFreePort` - `port: 0` only tells
 * you the port after listening starts, but the fake IdP's issuer/discovery
 * URL has to be baked into the app-under-test's OIDC_DISCOVERY_URL config
 * before that app boots, i.e. before either server is actually listening.
 */
async function reserveFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createNetServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			probe.close(() => {
				if (!address || typeof address === "string") {
					reject(new Error("failed to reserve a free port"));
					return;
				}
				resolve(address.port);
			});
		});
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

async function handleRequest(
	idp: FakeIdp,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const url = new URL(req.url ?? "/", idp.issuer);

	if (url.pathname === new URL(idp.discoveryUrl).pathname) {
		sendJson(res, 200, idp.discoveryDocument());
		return;
	}

	if (url.pathname === new URL(idp.jwksUrl).pathname) {
		sendJson(res, 200, await idp.jwks());
		return;
	}

	if (url.pathname === new URL(idp.authorizationUrl).pathname) {
		// A real IdP would authenticate the resource owner here. The fake only
		// needs to close the authorization-code loop so a real HTTP redirect
		// round trip can be driven end to end - it echoes an opaque code
		// straight back to redirect_uri with no PKCE/consent/credential
		// verification, since none of that is a business rule the production
		// code under test independently implements at this hop.
		const redirectUri = url.searchParams.get("redirect_uri");
		if (!redirectUri) {
			sendJson(res, 400, { error: "invalid_request", error_description: "missing redirect_uri" });
			return;
		}
		const callback = new URL(redirectUri);
		callback.searchParams.set("code", `fake-idp-code-${crypto.randomUUID()}`);
		const state = url.searchParams.get("state");
		if (state !== null) {
			callback.searchParams.set("state", state);
		}
		res.writeHead(302, { location: callback.toString() });
		res.end();
		return;
	}

	if (url.pathname === new URL(idp.tokenUrl).pathname && req.method === "POST") {
		const rawBody = await readBody(req);
		const { status, body } = await idp.handleTokenRequest(rawBody);
		sendJson(res, status, body);
		return;
	}

	sendJson(res, 404, { error: "not_found" });
}

/**
 * Boots a real `node:http` server exposing the fake IdP's discovery, JWKS,
 * authorize, and token endpoints - the Node-transport peer of
 * `installFakeIdpFetch`, for the self-hosted e2e test that drives a full OIDC
 * round trip without patching `fetch`.
 *
 * `idp.issuer` must already carry the port this server will bind to (reserve
 * one with the module-local `reserveFreePort` pattern, pass
 * `http://127.0.0.1:<port>` into `createFakeIdp`, *then* call this function -
 * mirroring why `test/self-host/e2e.test.ts` reserves the app's own port up
 * front, before booting the runtime that needs to know its own public URL).
 */
export async function startFakeIdpServer(idp: FakeIdp): Promise<FakeIdpServer> {
	const issuerUrl = new URL(idp.issuer);
	const port = Number(issuerUrl.port);
	if (!port) {
		throw new Error(
			`startFakeIdpServer requires idp.issuer to include an explicit port (got "${idp.issuer}") - reserve a port with reserveFreePort() and pass "http://127.0.0.1:<port>" to createFakeIdp before calling startFakeIdpServer`,
		);
	}

	const server = createServer((req, res) => {
		void handleRequest(idp, req, res);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, issuerUrl.hostname, () => resolve());
	});

	return {
		baseUrl: idp.issuer,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

export { reserveFreePort };
