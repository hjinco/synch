import { Setting } from "obsidian";
import { getSynchLocale, t } from "../../../i18n";
import type { SynchSubscriptionStatus } from "../../contracts";
import type { SynchSettingsController } from "../controller";
import { RefreshSettings } from "./shared";

export function renderSubscriptionSetting(
  containerEl: HTMLElement,
  controller: SynchSettingsController,
  refresh: RefreshSettings,
): void {
  const status = controller.getSubscriptionStatus();
  const setting = new Setting(containerEl)
    .setName(t("subscription.label"))
    .setDesc(formatSubscriptionDescription(status));

  if (status.state === "failed") {
    setting.addButton((button) =>
      button.setButtonText(t("refresh")).onClick(async () => {
        await controller.retrySubscriptionStatusCheck();
        refresh();
      }),
    );
    return;
  }

  if (status.state !== "loaded") {
    return;
  }

  if (status.active) {
    setting.addButton((button) =>
      button.setButtonText(t("subscription.manage")).onClick(() => {
        controller.openBillingManagementPage();
      }),
    );
    return;
  }

  setting.addButton((button) =>
    button.setButtonText(t("subscription.upgrade")).onClick(() => {
      controller.openPricingPage();
    }),
  );
}

function formatSubscriptionDescription(
  status: SynchSubscriptionStatus,
): string {
  if (status.state === "idle" || status.state === "checking") {
    return t("subscription.checking");
  }

  if (status.state === "failed") {
    return t("subscription.failed");
  }

  if (status.state !== "loaded") {
    return t("subscription.checking");
  }

  const planName = formatSubscriptionPlanName(status.planId);
  if (status.active && status.cancelAtPeriodEnd && status.periodEnd) {
    return t("subscription.canceling", {
      plan: planName,
      periodEnd: formatSubscriptionPeriodEnd(status.periodEnd),
    });
  }

  return t("subscription.currentPlan", { plan: planName });
}

function formatSubscriptionPlanName(planId: string): string {
  switch (planId) {
    case "starter":
      return t("subscription.starterPlan");
    default:
      return t("subscription.freePlan");
  }
}

function formatSubscriptionPeriodEnd(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(getSynchLocale(), {
    dateStyle: "medium",
  }).format(date);
}
