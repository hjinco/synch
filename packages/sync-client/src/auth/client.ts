import {
  extractErrorCode,
  extractErrorMessage,
  stripTrailingSlash,
  type HttpClient,
} from "../http/request";

export interface DeviceAuthorizationStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export type DeviceAuthorizationPollResult =
  | {
      status: "approved";
      accessToken: string;
      expiresIn: number;
      scope: string;
    }
  | {
      status: "pending";
      intervalMs: number;
      message: string;
    }
  | {
      status: "slow_down";
      intervalMs: number;
      message: string;
    }
  | {
      status: "denied" | "expired" | "invalid";
      message: string;
    };

export interface AuthenticatedUserSession {
  userId: string;
  email: string;
  name: string;
}

type DeviceTokenSuccess = {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};

type DeviceTokenError = {
  error?: string;
  error_description?: string;
};

type SessionResponse = {
  session?: { id: string };
  user?: {
    id: string;
    email: string;
    name?: string | null;
  };
} | null;

export class AuthClient {
  constructor(
    private readonly httpClient: HttpClient,
    private readonly clientId: string,
  ) {
    if (!clientId.trim()) {
      throw new Error("Device authorization client ID is required.");
    }
  }

  async startDeviceAuthorization(apiBaseUrl: string): Promise<DeviceAuthorizationStart> {
    const response = await this.httpClient.request({
      url: `${stripTrailingSlash(apiBaseUrl)}/api/auth/device/code`,
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: this.clientId,
      }),
    });

    if (response.status !== 200) {
      const detail =
        extractErrorMessage(response.json) || extractErrorCode(response.json);
      throw new Error(
        detail
          ? `device authorization failed with status ${response.status}: ${detail}`
          : `device authorization failed with status ${response.status}`,
      );
    }

    const json = (response.json ?? {}) as Partial<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    }>;

    if (
      typeof json.device_code !== "string" ||
      typeof json.user_code !== "string" ||
      typeof json.verification_uri !== "string" ||
      typeof json.verification_uri_complete !== "string" ||
      typeof json.expires_in !== "number" ||
      typeof json.interval !== "number"
    ) {
      throw new Error("invalid device authorization response");
    }

    return {
      deviceCode: json.device_code,
      userCode: json.user_code,
      verificationUri: json.verification_uri,
      verificationUriComplete: json.verification_uri_complete,
      expiresIn: json.expires_in,
      interval: json.interval,
    };
  }

  async pollDeviceAuthorization(
    apiBaseUrl: string,
    deviceCode: string,
  ): Promise<DeviceAuthorizationPollResult> {
    const response = await this.httpClient.request({
      url: `${stripTrailingSlash(apiBaseUrl)}/api/auth/device/token`,
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: this.clientId,
      }),
    });

    if (response.status === 200) {
      const json = response.json as Partial<DeviceTokenSuccess>;
      if (
        typeof json.access_token !== "string" ||
        typeof json.expires_in !== "number" ||
        typeof json.scope !== "string"
      ) {
        throw new Error("invalid approved device authorization response");
      }

      return {
        status: "approved",
        accessToken: json.access_token,
        expiresIn: json.expires_in,
        scope: json.scope,
      };
    }

    const json = response.json as DeviceTokenError;
    const message = json.error_description ?? json.error ?? "device authorization failed";

    switch (json.error) {
      case "authorization_pending":
        return {
          status: "pending",
          intervalMs: 5_000,
          message,
        };
      case "slow_down":
        return {
          status: "slow_down",
          intervalMs: 10_000,
          message,
        };
      case "access_denied":
        return {
          status: "denied",
          message,
        };
      case "expired_token":
        return {
          status: "expired",
          message,
        };
      case "invalid_grant":
      case "invalid_request":
        return {
          status: "invalid",
          message,
        };
      default:
        throw new Error(message);
    }
  }

  async getAuthenticatedUser(
    apiBaseUrl: string,
    sessionToken: string,
  ): Promise<AuthenticatedUserSession | null> {
    const response = await this.httpClient.request({
      url: `${stripTrailingSlash(apiBaseUrl)}/api/auth/get-session`,
      method: "GET",
      headers: sessionToken.trim()
        ? {
            authorization: `Bearer ${sessionToken}`,
          }
        : {},
    });

    if (response.status !== 200) {
      throw new Error(`session lookup failed with status ${response.status}`);
    }

    const json = response.json as SessionResponse;
    if (!json?.user) {
      return null;
    }

    return {
      userId: json.user.id,
      email: json.user.email,
      name: json.user.name ?? "",
    };
  }

  async signOut(apiBaseUrl: string, sessionToken: string): Promise<void> {
    await this.httpClient.request({
      url: `${stripTrailingSlash(apiBaseUrl)}/api/auth/sign-out`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({}),
    });
  }
}
