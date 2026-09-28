import { App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultKeyRequest } from "@synch/sync-client/remote";
import {
  getButtonComponents, getCreatedElements, getCreatedElementTexts,
  getOpenModals, getTextComponents, resetObsidianMocks,
} from "../../test-stubs/obsidian";
import { t } from "../../i18n";
import { ConnectVaultFlow, type ConnectableVault } from "./connect-vault-flow";
import { openConnectVaultModal } from "./connect-vault-modal";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const button = (label: string) => getButtonComponents().findLast((entry) => entry.text === label)!;
const inlineError = (message: string) => getCreatedElements().some((element) =>
  element.classes.includes("synch-modal-error") && element.text === message,
);

function setup(status: "active" | "pending_key" = "active") {
  const item: ConnectableVault = {
    vault: { id: "vault", name: "Team notes", personal: false, canManage: false, status, shared: true, members: [] },
    organizationName: "Team", sharingEnabled: true,
  };
  const flow = {
    assertCurrentAccount: vi.fn(),
    list: vi.fn(async () => [item]),
    blockingReason: vi.fn(async (): Promise<string | null> => null),
    localRequest: vi.fn(async (): Promise<VaultKeyRequest | null> => null),
    verificationCode: vi.fn(async () => "verified-local-code"),
    request: vi.fn(async () => {}),
    connect: vi.fn(async () => true),
  };
  const open = () => openConnectVaultModal(new App(), flow as unknown as ConnectVaultFlow, null);
  return { item, flow, open };
}

beforeEach(resetObsidianMocks);

describe("connect vault onboarding", () => {
  it("offers password connection without recovery controls on older servers", async () => {
    const { item, open } = setup();
    item.sharingEnabled = false;
    item.vault.personal = true;
    item.vault.shared = false;
    item.organizationName = "";
    const result = open();
    await tick();
    await button("Team notes").click();
    expect(getTextComponents()).toHaveLength(1);
    expect(getButtonComponents().map(entry => entry.text)).not.toContain(t("sharing.recovery"));
    getOpenModals().at(-1)?.close();
    await expect(result).resolves.toBe(false);
  });

  it("starts with a picker and no password or automatic selection", async () => {
    const { open, flow } = setup();
    void open();
    await tick();
    expect(getTextComponents()).toHaveLength(0);
    expect(flow.blockingReason).not.toHaveBeenCalled();
    expect(getButtonComponents().map((entry) => entry.text)).toEqual([
      t("sharing.refresh"), "Team notes", t("sharing.refresh"),
    ]);
    await button("Team notes").click();
    expect(getTextComponents()).toHaveLength(1);
    await button(t("vault.allVaults")).click();
    expect(getButtonComponents().at(-2)?.text).toBe("Team notes");
    expect(getButtonComponents().at(-1)?.text).toBe(t("sharing.refresh"));
  });

  it("shows organizations and invitation labels, and connects on Enter", async () => {
    const { open, flow } = setup();
    const result = open();
    await tick();
    await button("Team notes")?.click();
    expect(getCreatedElementTexts()).toContain("Team");
    await getTextComponents().at(-1)?.change("my password");
    await getTextComponents().at(-1)?.pressKey("Enter");
    expect(flow.connect).toHaveBeenCalledWith("vault", "my password", undefined);
    await expect(result).resolves.toBe(true);
  });

  it("shows connection errors inline and lets the user retry or cancel", async () => {
    const { open, flow } = setup();
    flow.connect.mockRejectedValueOnce(new Error("Wrong password"));
    const result = open();
    await tick();
    await button("Team notes")?.click();
    await getTextComponents().at(-1)?.change("wrong");
    await button(t("vault.connect")).click();
    expect(inlineError("Wrong password")).toBe(true);
    getOpenModals().at(-1)?.close();
    await expect(result).resolves.toBe(false);
  });

  it("cannot cancel, change the selected vault, or submit twice while connecting", async () => {
    const { open, flow } = setup();
    let finish!: (connected: boolean) => void;
    flow.connect.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const result = open();
    await tick();
    await button("Team notes")?.click();
    const submit = button(t("vault.connect")).click();
    await tick();
    expect(button(t("vault.allVaults")).disabled).toBe(true);
    getOpenModals().at(-1)?.close();
    expect(getOpenModals()).toHaveLength(1);
    await button(t("vault.connect")).click();
    expect(flow.connect).toHaveBeenCalledOnce();
    finish(true);
    await submit;
    await expect(result).resolves.toBe(true);
  });

  it("guides pending access through request, verified code, approval, and personal password", async () => {
    const { open, flow } = setup("pending_key");
    const request = { status: "pending", expiresAt: Date.now() + 60_000 } as VaultKeyRequest;
    flow.request.mockImplementation(async () => { flow.localRequest.mockResolvedValue(request); });
    const result = open();
    await tick();
    await button("Team notes")?.click();
    expect(getTextComponents()).toHaveLength(0);
    await button(t("sharing.request")).click();
    expect(flow.request).toHaveBeenCalledWith("vault");
    expect(getCreatedElementTexts()).toContain("verified-local-code");
    expect(getCreatedElementTexts()).toContain(t("sharing.waiting"));
    request.status = "approved";
    await button(t("vault.checkApproval")).click();
    const [password, confirm] = getTextComponents().slice(-2);
    await password?.change("my new password");
    await confirm?.change("my new password");
    await button(t("vault.saveAndConnect")).click();
    expect(flow.connect).toHaveBeenCalledWith("vault", "my new password", "my new password");
    await expect(result).resolves.toBe(true);
  });

  it("resumes an approved request when the picker is reopened", async () => {
    const { open, flow } = setup("pending_key");
    flow.localRequest.mockResolvedValue({ status: "approved", expiresAt: Date.now() + 60_000 } as VaultKeyRequest);
    void open();
    await tick();
    await button("Team notes")?.click();
    expect(button(t("vault.saveAndConnect"))).toBeDefined();
    expect(flow.verificationCode).not.toHaveBeenCalled();
    expect(flow.request).not.toHaveBeenCalled();
  });

  it("offers explicit replacement when a saved request is missing on the server", async () => {
    const { open, flow } = setup("pending_key");
    flow.localRequest.mockRejectedValueOnce(new Error("Request not found"));
    void open();
    await tick();
    await button("Team notes")?.click();
    expect(inlineError("Request not found")).toBe(true);
    await button(t("sharing.restart")).click();
    expect(flow.request).toHaveBeenCalledWith("vault", true);
  });

  it("shows an empty-vault explanation without password or approval controls when blocked", async () => {
    const { open, flow } = setup("pending_key");
    flow.blockingReason.mockResolvedValue(t("vault.invitedNeedsEmpty"));
    void open();
    await tick();
    await button("Team notes")?.click();
    expect(getCreatedElementTexts()).toContain(t("vault.invitedNeedsEmpty"));
    expect(getTextComponents()).toHaveLength(0);
    expect(getButtonComponents().some((entry) => entry.text === t("sharing.request"))).toBe(false);
  });

  it("offers retry after a list error and explains web invitation acceptance for an empty list", async () => {
    const { open, flow } = setup();
    flow.list.mockRejectedValueOnce(new Error("offline")).mockResolvedValue([]);
    void open();
    await tick();
    await button("Team notes")?.click();
    expect(inlineError("offline")).toBe(true);
    await button(t("sharing.refresh")).click();
    expect(getCreatedElementTexts()).toContain(t("vault.noVaults"));
    expect(getCreatedElementTexts()).toContain(t("vault.acceptOnWeb"));
  });

  it("does not reveal request codes or submit after the account changes", async () => {
    const { open, flow } = setup("pending_key");
    void open();
    await tick();
    await button("Team notes")?.click();
    flow.assertCurrentAccount.mockImplementation(() => { throw new Error(t("sharing.accountChanged")); });
    await button(t("sharing.request")).click();
    expect(flow.request).not.toHaveBeenCalled();
    expect(inlineError(t("sharing.accountChanged"))).toBe(true);
  });
});
