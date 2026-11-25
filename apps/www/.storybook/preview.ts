import type { AstroRenderer } from "@storybook-astro/framework";
import type { ProjectAnnotations } from "storybook/internal/types";
import { setupWorker } from "msw/browser";
import { mswLoader } from "msw-storybook-addon/csf3";
import { defaults } from "../stories/mocks";
import "../src/styles/global.css";
import "./preview.css";

const preview: ProjectAnnotations<AstroRenderer> = {
  loaders: [
    mswLoader(async () => {
      const worker = setupWorker(...defaults);
      await worker.start({ onUnhandledFrame: "bypass" });
      return worker;
    }),
  ],
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        desktop: {
          name: "Desktop",
          styles: { width: "1440px", height: "900px" },
        },
        mobile: { name: "Mobile", styles: { width: "390px", height: "844px" } },
      },
    },
    options: { storySort: { order: ["Pages", "Components"] } },
  },
  beforeEach() {
    document.documentElement.lang = "en";
    document.documentElement.classList.add("dark");
    document.body.className =
      "bg-[#0a0a0a] text-zinc-400 font-sans antialiased selection:bg-zinc-800 selection:text-zinc-200 min-h-screen flex flex-col text-sm";
  },
};
export default preview;
