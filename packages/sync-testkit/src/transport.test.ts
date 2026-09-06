import { afterEach, expect, it, vi } from "vitest";
import { createTransport } from "./transport";
afterEach(() => vi.unstubAllGlobals());
it("keeps blob responses binary and lets E2E explicitly capture before corruption", async () => {
  const bytes = new Uint8Array([0, 255, 128, 42]);
  const fetch = vi.fn(async () => new Response(bytes));
  vi.stubGlobal("fetch", fetch);
  const plain = createTransport();
  const response = await plain.httpClient.request({ url: "http://localhost/blobs/test" });
  expect(response.arrayBuffer).toEqual(bytes.buffer);
  expect(response.text).toBeUndefined(); expect(response.json).toBeUndefined();
  let captured: Uint8Array | undefined;
  const observed = createTransport({ response: (_input, _status, buffer) => {
    captured = new Uint8Array(buffer.slice(0)); new Uint8Array(buffer)[0] = 1;
  } });
  const changed = await observed.httpClient.request({ url: "http://localhost/blobs/test" });
  expect(captured).toEqual(bytes);
  expect(new Uint8Array(changed.arrayBuffer!)[0]).toBe(1);
  plain.close(); observed.close();
});
it("parses structured errors and forwards cancellation", async () => {
  const fetch = vi.fn(async () => new Response('{"error":"quota"}', { status: 413 }));
  vi.stubGlobal("fetch", fetch);
  const client = createTransport();
  const response = await client.httpClient.request({ url: "http://localhost/blobs/test", method: "PUT", body: new ArrayBuffer(2) });
  expect(response.json).toEqual({ error: "quota" });
  client.close();
  expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
});
