import { diffLines, type Change } from "diff";
import { Component, MarkdownRenderer, Modal, Setting, type App } from "obsidian";

import { t } from "../../i18n";
import type { SynchVersionPreview } from "../contracts";

export class VersionPreviewModal extends Modal {
  private readonly renderComponent = new Component();
  private imageObjectUrl: string | null = null;

  constructor(
    app: App,
    private readonly preview: SynchVersionPreview,
  ) {
    super(app);
  }

  onOpen(): void {
    this.renderComponent.load();
    const { contentEl } = this;
    contentEl.empty();
    new Setting(contentEl).setName(t("version.previewHeader")).setHeading();
    contentEl.createDiv({
      cls: "synch-preview-path",
      text: this.preview.path,
    });

    const meta = formatPreviewMeta(this.preview);
    if (meta) {
      contentEl.createDiv({
        cls: "synch-preview-meta",
        text: meta,
      });
    }

    if (this.preview.status === "unavailable") {
      contentEl.createEl("p", {
        cls: "synch-modal-empty",
        text: this.preview.message,
      });
      return;
    }

    if (this.preview.status === "image") {
      this.imageObjectUrl = URL.createObjectURL(
        new Blob([copyToArrayBuffer(this.preview.bytes)], {
          type: this.preview.mimeType,
        }),
      );
      const previewEl = contentEl.createDiv({
        cls: "synch-preview-content synch-preview-image",
      });
      previewEl.createEl("img", {
        attr: {
          alt: this.preview.path,
          src: this.imageObjectUrl,
        },
      });
      return;
    }

    const previewText = this.preview.text;
    if (this.preview.currentText !== undefined) {
      renderDiffPreview(contentEl, previewText, this.preview.currentText);
      return;
    }

    if (isMarkdownPath(this.preview.path)) {
      const previewEl = contentEl.createDiv({
        cls: "synch-preview-content",
      });
      previewEl.addClass("synch-preview-rendered");
      previewEl.addClass("markdown-rendered");
      void MarkdownRenderer.render(
        this.app,
        previewText,
        previewEl,
        this.preview.path,
        this.renderComponent,
      ).catch(() => {
        previewEl.empty();
        previewEl.addClass("synch-preview-raw");
        previewEl.setText(previewText);
      });
      return;
    }

    const previewEl = contentEl.createEl("pre", {
      cls: "synch-preview-content",
      text: previewText,
    });
    previewEl.addClass("synch-preview-raw");
  }

  onClose(): void {
    this.renderComponent.unload();
    if (this.imageObjectUrl) {
      URL.revokeObjectURL(this.imageObjectUrl);
      this.imageObjectUrl = null;
    }
  }
}

function renderDiffPreview(
  contentEl: HTMLElement,
  versionText: string,
  currentText: string,
): void {
  const diffEl = contentEl.createDiv({
    cls: "synch-preview-content synch-preview-diff",
  });
  const legend = diffEl.createDiv({ cls: "synch-preview-diff-legend" });
  legend.createSpan({
    cls: "synch-preview-diff-legend-removed",
    text: t("version.diffRemoved"),
  });
  legend.createSpan({
    cls: "synch-preview-diff-legend-added",
    text: t("version.diffAdded"),
  });

  const changes = diffLines(versionText, currentText);
  if (changes.length === 1 && !changes[0]?.added && !changes[0]?.removed) {
    diffEl.createEl("p", {
      cls: "synch-preview-diff-empty",
      text: t("version.diffNoChanges"),
    });
    return;
  }

  const body = diffEl.createDiv({ cls: "synch-preview-diff-body" });
  for (const change of changes) {
    renderDiffChange(body, change);
  }
}

function renderDiffChange(container: HTMLElement, change: Change): void {
  const className = change.added
    ? "synch-preview-diff-added"
    : change.removed
      ? "synch-preview-diff-removed"
      : "synch-preview-diff-context";
  const marker = change.added ? "+" : change.removed ? "-" : " ";

  const lines = change.value.split("\n");
  const lineCount = change.value.endsWith("\n") ? lines.length - 1 : lines.length;
  for (let index = 0; index < lineCount; index += 1) {
    const row = container.createDiv({
      cls: `synch-preview-diff-row ${className}`,
    });
    row.createSpan({
      cls: "synch-preview-diff-marker",
      text: marker,
    });
    row.createEl("code", {
      cls: "synch-preview-diff-line",
      text: lines[index] === "" ? " " : lines[index],
    });
  }
}

function isMarkdownPath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return lowerPath.endsWith(".md") || lowerPath.endsWith(".markdown");
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function formatPreviewMeta(preview: SynchVersionPreview): string {
  const parts: string[] = [];
  if (preview.capturedAt !== null) {
    parts.push(new Date(preview.capturedAt).toLocaleString());
  }
  if (preview.reason) {
    parts.push(formatReason(preview.reason));
  }
  return parts.join(" · ");
}

function formatReason(reason: NonNullable<SynchVersionPreview["reason"]>): string {
  if (reason === "before_delete") {
    return t("version.beforeDelete");
  }
  if (reason === "before_restore") {
    return t("version.beforeRestore");
  }
  if (reason === "manual") {
    return t("version.manual");
  }
  return "Auto";
}
