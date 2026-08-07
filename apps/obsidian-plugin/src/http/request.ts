import { requestUrl } from "obsidian";

export interface HttpRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | string;
}

export interface HttpResponseLike {
  status: number;
  json?: unknown;
  text?: string;
  arrayBuffer?: ArrayBuffer;
}

export interface HttpClient {
  request(input: HttpRequestInput): Promise<HttpResponseLike>;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export class ObsidianHttpClient implements HttpClient {
  async request(input: HttpRequestInput): Promise<HttpResponseLike> {
    return (await requestUrl({
      url: input.url,
      method: input.method ?? "GET",
      throw: false,
      headers: input.headers,
      body: input.body,
    }));
  }
}

export const defaultHttpClient: HttpClient = new ObsidianHttpClient();

export function extractErrorMessage(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message;
  }
  if (typeof record.error === "string" && record.error.trim()) {
    return record.error;
  }

  return "";
}

export function extractErrorCode(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim()) {
    return record.error;
  }
  if (typeof record.code === "string" && record.code.trim()) {
    return record.code;
  }

  return "";
}

export function createApiRequestError(
  response: HttpResponseLike,
  fallbackMessage: string,
): ApiRequestError {
  const message = extractErrorMessage(response.json) || fallbackMessage;
  const code = extractErrorCode(response.json) || `http_${response.status}`;
  return new ApiRequestError(response.status, code, message);
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
