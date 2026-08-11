import { t } from "../../i18n";
import type {
  RemoteVaultNoticeEvent,
  RemoteVaultStatus,
} from "@synch/sync-client/remote-vault/manager";

export function formatRemoteVaultStatusLabel(
  status: RemoteVaultStatus,
): string {
  switch (status.state) {
    case "loaded":
      return t("vault.loaded", { label: status.label });
    case "stored_inactive":
      return t("vault.notActive");
    case "not_configured":
      return t("vault.notConfigured");
  }
}

export function formatRemoteVaultNotice(event: RemoteVaultNoticeEvent): string {
  switch (event.type) {
    case "disconnected":
      return t("vault.disconnected", { label: event.label });
    case "created_connected":
      return t("vault.createdConnected", { label: event.label });
    case "connected":
      return t("vault.connected", { label: event.label });
  }
}
