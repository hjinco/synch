import { App, Modal, Setting, setIcon, type ButtonComponent } from "obsidian";
import { t } from "../../i18n";
import { submitOnEnter } from "../keyboard";
import { ConnectVaultFlow, type ConnectableVault } from "./connect-vault-flow";

export function openConnectVaultModal(
  app: App,
  flow: ConnectVaultFlow,
  preferredVaultId: string | null,
): Promise<boolean> {
  return new ConnectVaultModal(app, flow, preferredVaultId).openAndWait();
}

export class ConnectVaultModal extends Modal {
  private resolve: ((connected: boolean) => void) | null = null;
  private connected = false;
  private busy = false;
  private closed = false;
  private controls: ButtonComponent[] = [];
  private errorEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private selectedId: string | null = null;
  private recovering = false;

  constructor(app: App, private readonly flow: ConnectVaultFlow, private readonly preferredId: string | null) {
    super(app);
  }

  openAndWait(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    this.modalEl.addClass("synch-connect-modal");
    this.contentEl.addClass("synch-connect");
    this.bodyEl = this.contentEl.createDiv();
    this.errorEl = this.contentEl.createEl("p", { cls: "synch-modal-error" });
    this.errorEl.setAttribute("role", "alert");
    this.renderList([], true);
    void this.run(() => this.refresh());
  }

  close(): void {
    if (!this.busy) super.close();
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    this.resolve?.(this.connected);
    this.resolve = null;
  }

  private row(cls: string, parent = this.bodyEl): Setting {
    const row = new Setting(parent);
    row.settingEl.addClass(cls);
    return row;
  }

  private addButton(setting: Setting, label: string, action: () => Promise<void> | void, cta = false): ButtonComponent {
    let control!: ButtonComponent;
    setting.addButton((button) => {
      button.setButtonText(label).setDisabled(this.busy).onClick(action);
      if (cta) button.setCta();
      this.controls.push(button);
      control = button;
    });
    return control;
  }

  private primary(label: string, action: () => Promise<void>): void {
    this.addButton(this.row("synch-connect-primary"), label, () => this.run(action), true);
  }

  private resetScreen(): void {
    this.controls = [];
    this.bodyEl.empty();
  }

  private title(title: string, description?: string): void {
    this.bodyEl.createEl("h2", { text: title });
    if (description) this.bodyEl.createEl("p", { text: description, cls: "synch-connect-hint" });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    this.errorEl.setText("");
    this.controls.forEach((button) => { button.setDisabled(true); });
    try {
      this.flow.assertCurrentAccount();
      await action();
    } catch (error) {
      this.errorEl.setText(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
      this.controls.forEach((button) => { button.setDisabled(false); });
      if (this.connected) this.close();
    }
  }

  private async refresh(): Promise<void> {
    const items = await this.flow.list();
    if (this.selectedId === null) {
      this.renderList(items);
      return;
    }
    const selected = items.find((item) => item.vault.id === this.selectedId);
    if (!selected) {
      this.selectedId = null;
      this.renderList(items);
      throw new Error(t("vault.remoteAccessUnavailable"));
    }
    await this.renderAccess(selected);
  }

  private renderList(items: ConnectableVault[], loading = false): void {
    this.resetScreen();
    this.title(t("vault.choose"));
    for (const owned of [true, false]) {
      const group = items.filter((item) => (item.vault.personal) === owned);
      if (!group.length) continue;
      this.bodyEl.createEl("h3", { text: t(owned ? "vault.yourVaults" : "vault.sharedWithYou"), cls: "synch-connect-group" });
      // A previous connection affects ordering only; the user always chooses.
      group.sort((a, b) => Number(b.vault.id === this.preferredId) - Number(a.vault.id === this.preferredId));
      for (const item of group) {
        const button = this.addButton(this.row("synch-connect-choice"), item.vault.name, () => this.run(async () => {
          this.selectedId = item.vault.id;
          this.recovering = false;
          await this.refresh();
        }));
        const el = button.buttonEl;
        el.empty();
        const icon = el.createSpan({ cls: "synch-connect-vault-icon" });
        setIcon(icon, owned ? "vault" : "users");
        icon.setAttribute("aria-hidden", "true");
        const text = el.createSpan({ cls: "synch-connect-choice-text" });
        text.createSpan({ text: item.vault.name });
        if (item.organizationName) text.createSpan({ text: item.organizationName, cls: "synch-connect-choice-meta" });
        const arrow = el.createSpan({ cls: "synch-connect-chevron" });
        setIcon(arrow, "chevron-right");
        arrow.setAttribute("aria-hidden", "true");
      }
    }
    if (!items.length) this.bodyEl.createEl("p", { text: t(loading ? "loading" : "vault.noVaults"), cls: "synch-connect-hint" });
    const help = this.bodyEl.createEl("details", { cls: "synch-connect-help" });
    help.createEl("summary", { text: t("vault.missingShared") });
    help.createEl("p", { text: t("vault.acceptOnWeb") });
    this.addButton(this.row("synch-connect-secondary"), t("sharing.refresh"), () => this.run(() => this.refresh()));
  }

  private async renderAccess(item: ConnectableVault): Promise<void> {
    this.resetScreen();
    this.addButton(this.row("synch-connect-back"), t("vault.allVaults"), () => this.run(async () => {
      this.selectedId = null;
      this.recovering = false;
      await this.refresh();
    }));
    if (item.organizationName) this.bodyEl.createEl("p", { text: item.organizationName, cls: "synch-connect-eyebrow" });
    this.title(item.vault.name);
    const blocked = await this.flow.blockingReason(item);
    this.flow.assertCurrentAccount();
    if (blocked) {
      this.bodyEl.createEl("p", { text: blocked, cls: "synch-connect-notice" });
      return;
    }
    const { vault } = item;
    if (vault.status === "active" && !this.recovering) {
      this.passwordForm(vault.id, false);
      if (item.sharingEnabled) this.addButton(this.row("synch-connect-secondary"), t("sharing.recovery"), () => this.run(async () => {
        this.recovering = true;
        await this.refresh();
      }));
      return;
    }
    if (vault.status === "active") this.addButton(this.row("synch-connect-secondary"), t("vault.usePassword"), () => this.run(async () => {
      this.recovering = false;
      await this.refresh();
    }));
    if (!item.sharingEnabled) {
      this.bodyEl.createEl("p", { text: t("sharing.suspended"), cls: "synch-connect-notice" });
      return;
    }
    let request;
    try {
      request = await this.flow.localRequest(vault.id);
    } catch (error) {
      this.renderRestart(vault.id);
      throw error;
    }
    if (request && request.status !== "canceled" && request.expiresAt > Date.now()) {
      if (request.status === "approved" || request.status === "completed") {
        this.bodyEl.createEl("p", { text: t("vault.accessApproved"), cls: "synch-connect-hint" });
        this.passwordForm(vault.id, true);
        return;
      }
      this.bodyEl.createEl("h3", { text: t("sharing.waiting"), cls: "synch-connect-status" });
      this.bodyEl.createEl("p", { text: t("sharing.yourCode"), cls: "synch-connect-hint" });
      const code = await this.flow.verificationCode(vault.id);
      this.bodyEl.createEl("code", { text: code, cls: "synch-connect-code" });
      this.addButton(this.row("synch-connect-secondary"), t("vault.copyCode"), () => this.run(async () => {
        await navigator.clipboard.writeText(code);
      }));
      this.primary(t("vault.checkApproval"), () => this.refresh());
      const help = this.bodyEl.createEl("details", { cls: "synch-connect-help" });
      help.createEl("summary", { text: t("vault.requestHelp") });
      this.renderRestart(vault.id, help);
      return;
    }
    if (request) {
      this.renderRestart(vault.id);
      return;
    }
    this.bodyEl.createEl("p", { text: t("sharing.requestHelp"), cls: "synch-connect-hint" });
    this.primary(t("sharing.request"), async () => {
      await this.flow.request(vault.id);
      await this.refresh();
    });
  }

  private renderRestart(vaultId: string, parent = this.bodyEl): void {
    parent.createEl("p", { text: t("sharing.restartHelp"), cls: "synch-connect-hint" });
    this.addButton(this.row("synch-connect-secondary", parent), t("sharing.restart"), () => this.run(async () => {
      await this.flow.request(vaultId, true);
      await this.refresh();
    }));
  }

  private passwordForm(vaultId: string, enrollment: boolean): void {
    let password = "";
    let confirmation = "";
    const submit = async (): Promise<void> => {
      this.connected = await this.flow.connect(vaultId, password, enrollment ? confirmation : undefined);
    };
    this.row("synch-connect-field")
      .setName(t(enrollment ? "sharing.setPassword" : "vault.password"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = enrollment ? "new-password" : "current-password";
        text.inputEl.setAttribute("aria-label", t(enrollment ? "sharing.setPassword" : "vault.password"));
        text.setPlaceholder(t("vault.passwordPlaceholder")).onChange((value) => { password = value; });
        submitOnEnter(text.inputEl, () => this.run(submit));
      });
    if (enrollment) this.row("synch-connect-field")
      .setName(t("vault.confirmPassword"))
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "new-password";
        text.inputEl.setAttribute("aria-label", t("vault.confirmPassword"));
        text.setPlaceholder(t("vault.passwordConfirmPlaceholder")).onChange((value) => { confirmation = value; });
        submitOnEnter(text.inputEl, () => this.run(submit));
      });
    this.primary(t(enrollment ? "vault.saveAndConnect" : "vault.connect"), submit);
  }
}
