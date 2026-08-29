import { beforeEach, describe, expect, it } from "vitest";
import { resetObsidianMocks } from "obsidian";

import type { UserVisibleSyncState } from "@synch/sync-client/sync/runtime/user-visible-status";
import { t } from "./index";
import { formatSyncStatusLabel } from "./sync-status";

type ProgressSyncState = Exclude<UserVisibleSyncState, "paused">;

describe("formatSyncStatusLabel", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it.each([
    ["not_ready", 37],
    ["pending", 37],
    ["syncing", 37],
    ["offline", 37],
    ["reconnecting", 37],
    ["up_to_date", 100],
    ["attention_needed", 37],
  ] satisfies Array<[ProgressSyncState, number]>) (
    "formats %s with its translated state and percent",
    (state, percent) => {
      expect(formatSyncStatusLabel(state, percent)).toBe(
        t("sync.status", {
          label: t(`sync.state.${state}`),
          percent,
        }),
      );
    },
  );

  it("does not include a stale percent for a paused sync", () => {
    expect(formatSyncStatusLabel("paused", 37)).toBe(t("sync.state.paused"));
  });

  it("uses the plugin update status for an update-required sync", () => {
    expect(formatSyncStatusLabel("update_required", 37)).toBe(
      t("plugin.updateRequiredStatus"),
    );
  });
});
