import { beforeEach, describe, expect, it } from "vitest";
import { resetObsidianMocks, setLanguage } from "obsidian";

import { formatErrorNotice, getSynchLocale, t } from "./index";

describe("Synch i18n", () => {
  beforeEach(() => {
    resetObsidianMocks();
  });

  it("defaults unsupported languages to English", () => {
    setLanguage("fr");

    expect(getSynchLocale()).toBe("en");
    expect(t("sync.label")).toBe("Sync");
  });

  it("uses Korean for ko language codes", () => {
    setLanguage("ko-KR");

    expect(getSynchLocale()).toBe("ko");
    expect(t("sync.label")).toBe("동기화");
  });

  it("localizes cursor mismatch errors without exposing the server message", () => {
    setLanguage("ko-KR");

    expect(
      formatErrorNotice(
        Object.assign(new Error("server cursor details"), {
          code: "cursor_ahead_of_server",
        }),
        "Auto sync failed",
      ),
    ).toBe(
      "이 기기의 동기화 기록이 원격 vault와 일치하지 않아 동기화를 중지했습니다. 다시 동기화하려면 Synch 설정에서 원격 vault의 연결을 해제한 후 다시 연결하세요.",
    );
  });

  it("localizes the context for other errors", () => {
    setLanguage("ko-KR");

    expect(formatErrorNotice(new Error("request failed"), "error.autoSync")).toBe(
      "자동 동기화 실패: request failed",
    );
  });

  it("localizes notification messages with dynamic values", () => {
    setLanguage("ko-KR");

    expect(t("auth.openingBrowser", { code: "ABCD-EFGH" })).toBe(
      "기기 로그인을 위해 브라우저를 여는 중...\n코드: ABCD-EFGH",
    );
    expect(t("sync.conflictLocalSaved", { path: "메모/충돌.md" })).toBe(
      '동기화 충돌이 감지되었습니다. 로컬 변경 사항을 "메모/충돌.md"에 저장했습니다.',
    );
  });

  it("uses Japanese for ja language codes", () => {
    setLanguage("ja-JP");

    expect(getSynchLocale()).toBe("ja");
    expect(t("sync.label")).toBe("同期");
  });

  it("uses simplified Chinese for zh-CN language codes", () => {
    setLanguage("zh-CN");

    expect(getSynchLocale()).toBe("zh-cn");
    expect(t("sync.label")).toBe("同步");
  });

  it("uses traditional Chinese for zh-TW language codes", () => {
    setLanguage("zh-TW");

    expect(getSynchLocale()).toBe("zh-tw");
    expect(t("sync.label")).toBe("同步");
  });

  it("uses German for de language codes", () => {
    setLanguage("de-DE");

    expect(getSynchLocale()).toBe("de");
    expect(t("sync.label")).toBe("Synchronisierung");
  });
});
