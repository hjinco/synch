import {
	calculateJwkThumbprint,
	exportJWK,
	generateKeyPair,
	SignJWT,
	type CryptoKey,
	type JSONWebKeySet,
	type JWK,
} from "jose";

const SIGNING_ALGORITHM = "ES256";
const DEFAULT_CLIENT_ID = "synch-test-client";
const DEFAULT_EMAIL = "user@fake-idp.test";
const DEFAULT_TOKEN_TTL_SECONDS = 300;

export type FakeIdpDiscoveryDocument = {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
	userinfo_endpoint: string;
	response_types_supported: string[];
	subject_types_supported: string[];
	id_token_signing_alg_values_supported: string[];
	scopes_supported: string[];
	claims_supported: string[];
	code_challenge_methods_supported: string[];
};

export type FakeIdpClaimOverrides = {
	iss?: string;
	aud?: string;
	sub?: string;
	email?: string;
	email_verified?: boolean;
	nonce?: string;
	exp?: number;
};

export type FakeIdpTokenRequestRecord = {
	rawBody: string;
	params: URLSearchParams;
};

export type FakeIdpTokenEndpointResult = {
	status: number;
	body: unknown;
};

export type FakeIdpTokenHandler = (
	request: FakeIdpTokenRequestRecord,
) => FakeIdpTokenEndpointResult | Promise<FakeIdpTokenEndpointResult>;

export type FakeIdpTokenResponseBody = {
	access_token: string;
	token_type: "Bearer";
	expires_in: number;
	id_token: string;
	scope: string;
};

export type FakeIdp = {
	readonly issuer: string;
	readonly discoveryUrl: string;
	readonly authorizationUrl: string;
	readonly tokenUrl: string;
	readonly jwksUrl: string;
	readonly userInfoUrl: string;
	readonly clientId: string;
	readonly tokenRequests: readonly FakeIdpTokenRequestRecord[];
	/**
	 * Mutable per-test hook invoked by `handleTokenRequest` after recording the
	 * incoming request. Defaults to signing and returning a fresh id_token;
	 * reassign it in a test to control the token-endpoint response (error
	 * bodies, non-200 statuses, a token signed with different claims, etc.)
	 * without touching the transport layer.
	 */
	tokenHandler: FakeIdpTokenHandler;
	discoveryDocument(): FakeIdpDiscoveryDocument;
	jwks(): Promise<JSONWebKeySet>;
	signIdToken(overrides?: FakeIdpClaimOverrides): Promise<string>;
	/** Signs with a key that is never published in `jwks()` - the only way to build a token that is cryptographically valid but untrusted, for JWKS-rejection tests. */
	signWithUnpublishedKey(overrides?: FakeIdpClaimOverrides): Promise<string>;
	tokenResponse(idToken: string): FakeIdpTokenResponseBody;
	recordTokenRequest(request: FakeIdpTokenRequestRecord): void;
	lastTokenRequest(): FakeIdpTokenRequestRecord | undefined;
	handleTokenRequest(rawBody: string): Promise<FakeIdpTokenEndpointResult>;
};

type FakeIdpKeyPair = {
	privateKey: CryptoKey;
	publicJwk: JWK;
	kid: string;
};

async function createSigningKeyPair(): Promise<FakeIdpKeyPair> {
	const { privateKey, publicKey } = await generateKeyPair(SIGNING_ALGORITHM, {
		extractable: true,
	});
	const publicJwk = await exportJWK(publicKey);
	const kid = await calculateJwkThumbprint(publicJwk);

	return {
		privateKey,
		publicJwk: { ...publicJwk, kid, alg: SIGNING_ALGORITHM, use: "sig" },
		kid,
	};
}

/**
 * Builds a transport-agnostic, real (not mocked/spied) minimal OIDC provider:
 * one published ES256 keypair plus a second, never-published keypair for the
 * signed-by-an-untrusted-key edge case. This module only serves protocol
 * responses - it must never encode a business rule (e.g. rejecting a bad
 * nonce) that the production code doesn't independently implement, or the
 * tests built on it would end up verifying the fake instead of the system
 * under test.
 */
export async function createFakeIdp(issuer: string): Promise<FakeIdp> {
	const normalizedIssuer = issuer.replace(/\/+$/, "");
	const [published, unpublished] = await Promise.all([
		createSigningKeyPair(),
		createSigningKeyPair(),
	]);

	const discoveryUrl = `${normalizedIssuer}/.well-known/openid-configuration`;
	const authorizationUrl = `${normalizedIssuer}/authorize`;
	const tokenUrl = `${normalizedIssuer}/token`;
	const jwksUrl = `${normalizedIssuer}/jwks`;
	const userInfoUrl = `${normalizedIssuer}/userinfo`;

	const tokenRequests: FakeIdpTokenRequestRecord[] = [];

	async function signWithKeyPair(
		keyPair: FakeIdpKeyPair,
		overrides: FakeIdpClaimOverrides,
	): Promise<string> {
		const nowSeconds = Math.floor(Date.now() / 1000);
		const extraClaims: Record<string, unknown> = {
			email: overrides.email ?? DEFAULT_EMAIL,
			email_verified: overrides.email_verified ?? true,
		};
		if (overrides.nonce !== undefined) {
			extraClaims.nonce = overrides.nonce;
		}

		return await new SignJWT(extraClaims)
			.setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: keyPair.kid })
			.setIssuer(overrides.iss ?? normalizedIssuer)
			.setAudience(overrides.aud ?? DEFAULT_CLIENT_ID)
			// A fixed fallback subject would let unrelated sign-ins silently share
			// one identity whenever a caller forgets to pass `sub` - account
			// linking matches on (issuer, subject), so that collision would merge
			// otherwise-unrelated accounts. Mint a fresh one per call instead, so
			// identity reuse across calls is always an explicit choice.
			.setSubject(overrides.sub ?? crypto.randomUUID())
			.setIssuedAt(nowSeconds)
			.setExpirationTime(overrides.exp ?? nowSeconds + DEFAULT_TOKEN_TTL_SECONDS)
			.sign(keyPair.privateKey);
	}

	async function signIdToken(overrides: FakeIdpClaimOverrides = {}): Promise<string> {
		return await signWithKeyPair(published, overrides);
	}

	async function signWithUnpublishedKey(overrides: FakeIdpClaimOverrides = {}): Promise<string> {
		return await signWithKeyPair(unpublished, overrides);
	}

	function tokenResponse(idToken: string): FakeIdpTokenResponseBody {
		return {
			access_token: `fake-idp-access-token-${crypto.randomUUID()}`,
			token_type: "Bearer",
			expires_in: 3600,
			id_token: idToken,
			scope: "openid profile email",
		};
	}

	const defaultTokenHandler: FakeIdpTokenHandler = async () => ({
		status: 200,
		body: tokenResponse(await signIdToken()),
	});

	const idp: FakeIdp = {
		issuer: normalizedIssuer,
		discoveryUrl,
		authorizationUrl,
		tokenUrl,
		jwksUrl,
		userInfoUrl,
		clientId: DEFAULT_CLIENT_ID,
		tokenRequests,
		tokenHandler: defaultTokenHandler,

		discoveryDocument(): FakeIdpDiscoveryDocument {
			return {
				issuer: normalizedIssuer,
				authorization_endpoint: authorizationUrl,
				token_endpoint: tokenUrl,
				jwks_uri: jwksUrl,
				userinfo_endpoint: userInfoUrl,
				response_types_supported: ["code"],
				subject_types_supported: ["public"],
				// WHY: better-auth's genericOAuth plugin derives `isOidc` from
				// `signingAlgs.length > 0` off this exact field. An empty (or
				// missing) list silently downgrades the provider to plain OAuth2 -
				// ID-token verification is skipped and the account subject falls
				// back to the opaque `profile.id` instead of `sub` - with no loud
				// config error, only a button that still appears to work. This is
				// the JWKS-analog of Phase 1's "must fail loudly, not silently"
				// business context, so the fake always publishes a non-empty list.
				id_token_signing_alg_values_supported: [SIGNING_ALGORITHM],
				scopes_supported: ["openid", "profile", "email"],
				claims_supported: ["sub", "email", "email_verified"],
				code_challenge_methods_supported: ["S256"],
			};
		},

		async jwks(): Promise<JSONWebKeySet> {
			return { keys: [published.publicJwk] };
		},

		signIdToken,
		signWithUnpublishedKey,
		tokenResponse,

		recordTokenRequest(request: FakeIdpTokenRequestRecord): void {
			tokenRequests.push(request);
		},

		lastTokenRequest(): FakeIdpTokenRequestRecord | undefined {
			return tokenRequests.at(-1);
		},

		async handleTokenRequest(rawBody: string): Promise<FakeIdpTokenEndpointResult> {
			const record: FakeIdpTokenRequestRecord = {
				rawBody,
				params: new URLSearchParams(rawBody),
			};
			idp.recordTokenRequest(record);
			return await idp.tokenHandler(record);
		},
	};

	return idp;
}
