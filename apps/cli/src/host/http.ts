import type {
  HttpClient,
  HttpRequestInput,
  HttpResponseLike,
} from "@synch/sync-client/http/request";

export class NodeHttpClient implements HttpClient {
  async request(input: HttpRequestInput): Promise<HttpResponseLike> {
    const response = await fetch(input.url, {
      method: input.method ?? "GET",
      headers: input.headers,
      body: input.body,
    });

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") ?? "";
    const result: HttpResponseLike = {
      status: response.status,
      arrayBuffer,
    };

    if (isTextLikeContentType(contentType)) {
      const text = new TextDecoder().decode(arrayBuffer);
      result.text = text;
      if (contentType.includes("json")) {
        try {
          result.json = JSON.parse(text) as unknown;
        } catch {
          // Leave json undefined for malformed payloads; callers handle it.
        }
      }
    }

    return result;
  }
}

function isTextLikeContentType(contentType: string): boolean {
  return (
    contentType.includes("json") ||
    contentType.startsWith("text/") ||
    contentType.includes("charset")
  );
}

export const defaultHttpClient: HttpClient = new NodeHttpClient();
