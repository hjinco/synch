import { describe, expect, it, vi } from "vitest";
import { ApiRequestError, type HttpResponseLike } from "../http/request";
import { OrganizationApiUnavailableError, SharingClient } from "./client";

function setup(responses: HttpResponseLike[]) {
  const request = vi.fn(async () => responses.shift()!);
  return { request, client: new SharingClient({ request }, "https://server.example", "token") };
}

describe("organization API discovery", () => {
  it("identifies the missing collection endpoint on older servers", async () => {
    const { client, request } = setup([{ status: 404, text: "404 Not Found" }]);
    await expect(client.organizations()).rejects.toBeInstanceOf(OrganizationApiUnavailableError);
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not mistake a removed organization for an unsupported server", async () => {
    const { client } = setup([
      { status: 200, json: { organizations: [{ id: "gone" }] } },
      { status: 404, json: { error: "not_found" } },
    ]);
    await expect(client.organizations()).rejects.toBeInstanceOf(ApiRequestError);
  });

  it.each([401, 403, 500, 503])("preserves collection errors (%s)", async status => {
    const { client } = setup([{ status, json: { error: "failed" } }]);
    await expect(client.organizations()).rejects.toMatchObject({ name: "ApiRequestError", status });
  });

  it("preserves network failures", async () => {
    const client = new SharingClient({ request: async () => { throw new Error("offline"); } }, "https://server.example", "token");
    await expect(client.organizations()).rejects.toThrow("offline");
  });
});
