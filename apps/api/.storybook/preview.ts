import type { Preview } from "@storybook/react-vite";
import { initialize, mswLoader } from "msw-storybook-addon";
import { defaults } from "../web/stories/mocks";
import "../web/src/styles.css";

initialize({ onUnhandledRequest: "bypass" }, defaults);

const preview: Preview = {
  loaders: [mswLoader],
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
    options: { storySort: { order: ["Pages", "Dialogs"] } },
  },
  beforeEach({ parameters }) {
    const locale = typeof parameters.locale === "string" ? parameters.locale : "en";
    document.documentElement.lang = locale;
    const original = location.href;
    const url = new URL(original);
    for (const key of [
      "lang",
      "error",
      "user_code",
      "return_uri",
      "invitationId",
      "organizationId",
      "return_to",
    ])
      url.searchParams.delete(key);
    url.searchParams.set("lang", locale);
    const query: unknown = parameters.query;
    if (query && typeof query === "object") {
      for (const [key, value] of Object.entries(query))
        url.searchParams.set(key, String(value));
    }
    history.replaceState(null, "", url);
    return () => history.replaceState(null, "", original);
  },
};
export default preview;
