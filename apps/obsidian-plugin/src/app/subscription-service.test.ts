import { beforeEach, expect, it, vi } from "vitest";
import { resetObsidianMocks, setRequestUrlMock } from "../test-stubs/obsidian";
import { SynchSubscriptionService } from "./subscription-service";

beforeEach(() => {
  resetObsidianMocks();
  vi.restoreAllMocks();
});
it("uses the selected vault's organization and ignores a previous organization's late response", async () => {
  let organizationId = "personal";
  let finishPersonal!: (value: unknown) => void;
  const status = (planId: string) => ({
    status: 200,
    json: {
      planId,
      billingInterval: "monthly",
      active: true,
      status: "active",
      cancelAtPeriodEnd: false,
      periodEnd: null,
    },
  });
  setRequestUrlMock(
    vi.fn(async (input: unknown) => {
      const url = new URL((input as { url: string }).url);
      if (url.searchParams.get("organizationId") === "personal")
        return new Promise((resolve) => {
          finishPersonal = resolve;
        });
      expect(url.searchParams.get("organizationId")).toBe("shared");
      return status("plus");
    }),
  );
  const service = new SynchSubscriptionService({
    getOrganizationId: () => organizationId,
    getApiBaseUrl: () => "https://api.synch.run",
    hasAuthenticatedSession: () => true,
    getAuthSessionToken: () => "token",
    refreshUi: vi.fn(),
  });
  const previous = service.ensureSubscriptionStatusCheck();
  organizationId = "shared";
  await service.ensureSubscriptionStatusCheck();
  expect(service.getSubscriptionStatus()).toMatchObject({
    state: "loaded",
    planId: "plus",
  });
  finishPersonal(status("starter"));
  await previous;
  expect(service.getSubscriptionStatus()).toMatchObject({
    state: "loaded",
    planId: "plus",
  });
});
