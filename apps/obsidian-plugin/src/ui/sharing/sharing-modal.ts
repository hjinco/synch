import { App, Modal, Notice, Setting } from "obsidian";
import {
  SharingManager,
  type SharingVault,
  type VaultKeyRequest,
  type RemoteVaultSession,
} from "@synch/sync-client/remote";
import { t } from "../../i18n";

export class SharingModal extends Modal {
  private closed = false;
  private busy = false;
  constructor(
    app: App,
    private readonly manager: SharingManager,
    private readonly activeSession: () => RemoteVaultSession | null,
    private readonly isCurrentAccount: () => boolean,
    private readonly openOrganizations: () => void,
  ) {
    super(app);
  }
  onOpen(): void {
    void this.refresh();
  }
  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }
  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy || this.closed) return;
    if (!this.isCurrentAccount()) {
      new Notice(t("sharing.accountChanged"));
      this.close();
      return;
    }
    this.busy = true;
    this.contentEl.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    try {
      await action();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 10000);
    } finally {
      this.busy = false;
      if (!this.closed) await this.refresh();
    }
  }
  private async refresh(): Promise<void> {
    if (this.closed) return;
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: t("sharing.title") });
    this.contentEl.createEl("p", { text: t("sharing.intro") });
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText(t("sharing.organizations"))
          .onClick(this.openOrganizations),
      )
      .addButton((button) =>
        button.setButtonText(t("sharing.refresh")).onClick(() => {
          void this.run(async () => {});
        }),
      );
    const body = this.contentEl.createDiv();
    try {
      const organizations = await this.manager.client.organizations();
      if (this.closed) return;
      for (const organization of organizations) {
        const vaults = organization.vaults.filter(
          (vault) =>
            vault.status === "active" || vault.status === "pending_key",
        );
        if (!vaults.length) continue;
        body.createEl("h3", { text: organization.name });
        for (const vault of vaults) {
          try {
            await this.renderVault(body, vault, organization.sharing.enabled);
          } catch (error) {
            body.createEl("p", {
              text: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    } catch (error) {
      body.createEl("p", {
        text: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private async renderVault(
    parent: HTMLElement,
    vault: SharingVault,
    canShare: boolean,
  ): Promise<void> {
    const section = parent.createDiv();
    section.createEl("h4", { text: vault.name });
    const key =
      this.activeSession()?.summary.vaultId === vault.id
        ? this.activeSession()?.remoteVaultKey
        : undefined;
    if (key && vault.status === "active")
      this.passwordForm(
        section,
        (password) =>
          this.manager.changePassword(
            vault.id,
            key,
            password.value,
            password.confirm,
          ),
        "change",
      );
    else if (canShare)
      new Setting(section)
        .setName(
          t(
            vault.status === "pending_key"
              ? "sharing.setup"
              : "sharing.recovery",
          ),
        )
        .setDesc(t("sharing.requestHelp"))
        .addButton((button) =>
          button.setButtonText(t("sharing.request")).onClick(() => {
            void this.run(async () => {
              await this.manager.begin(vault.id);
            });
          }),
        );
    if (!canShare) {
      if (vault.shared) section.createEl("p", { text: t("sharing.suspended") });
      else if (!key)
        section.createEl("p", { text: t("sharing.passwordConnect") });
      return;
    }
    const requests = await this.manager.client.requests(vault.id);
    let localRequest: VaultKeyRequest | null = null;
    try {
      localRequest = await this.manager.localRequest(vault.id);
    } catch (error) {
      section.createEl("p", {
        text: error instanceof Error ? error.message : String(error),
      });
    }
    if (
      localRequest?.status === "completed" &&
      !requests.some((request) => request.id === localRequest.id)
    )
      requests.push(localRequest);
    for (const request of requests) {
      if (request.userId === this.manager.userId) {
        // Only the device holding the matching receiver secret can authenticate this code.
        // Displaying an API-supplied public key on another device would trust the server.
        if (localRequest?.id === request.id) {
          section.createEl("p", { text: t("sharing.yourCode") });
          section.createEl("code", {
            text: await this.manager.recipientVerificationCode(vault.id),
          });
          if (request.status === "approved" || request.status === "completed")
            this.passwordForm(
              section,
              (password) =>
                this.manager.receive(
                  vault.id,
                  password.value,
                  password.confirm,
                ),
              "receive",
            );
          else section.createEl("p", { text: t("sharing.waiting") });
        }
        new Setting(section)
          .setDesc(t("sharing.restartHelp"))
          .addButton((button) =>
            button.setButtonText(t("sharing.restart")).onClick(() => {
              void this.run(async () => {
                await this.manager.restart(vault.id);
              });
            }),
          );
      } else if (
        request.status === "pending" &&
        vault.canManage
      ) {
        this.approvalForm(section, vault, request, key);
      }
    }
  }
  private approvalForm(
    parent: HTMLElement,
    vault: SharingVault,
    request: VaultKeyRequest,
    key?: Uint8Array,
  ): void {
    const member = vault.members.find(
      (member) => member.userId === request.userId,
    );
    const setting = new Setting(parent)
      .setName(
        `${member?.email ?? request.userId} · ${t(request.purpose === "recovery" ? "sharing.recovery" : "sharing.setup")}`,
      )
      .setDesc(t(key ? "sharing.approveHelp" : "sharing.connectFirst"));
    if (!key) return;
    let code = "";
    setting.addText((text) =>
      text.setPlaceholder(t("sharing.code")).onChange((value) => {
        code = value;
      }),
    );
    setting.addButton((button) =>
      button.setButtonText(t("sharing.approve")).onClick(() => {
        void this.run(() => this.manager.approve(request, key, code));
      }),
    );
  }
  private passwordForm(
    parent: HTMLElement,
    action: (password: { value: string; confirm: string }) => Promise<void>,
    mode: "change" | "receive",
  ): void {
    let value = "";
    let confirm = "";
    const setting = new Setting(parent)
      .setName(
        t(mode === "change" ? "sharing.changePassword" : "sharing.setPassword"),
      )
      .setDesc(t("sharing.passwordHelp"));
    setting.addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.autocomplete = "new-password";
      text.setPlaceholder(t("sharing.password")).onChange((next) => {
        value = next;
      });
    });
    setting.addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.autocomplete = "new-password";
      text.setPlaceholder(t("sharing.confirmPassword")).onChange((next) => {
        confirm = next;
      });
    });
    setting.addButton((button) =>
      button.setButtonText(t("sharing.save")).onClick(() => {
        void this.run(async () => {
          await action({ value, confirm });
          value = "";
          confirm = "";
          new Notice(
            t(mode === "receive" ? "sharing.ready" : "sharing.saved"),
            10000,
          );
        });
      }),
    );
  }
}
