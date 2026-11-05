import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse, delay } from "msw";
import { userEvent, within } from "storybook/test";
import { AuthPage } from "../src/pages/auth";
import { english, json } from "./mocks";

const meta = {
  title: "Pages/Sign in",
  loaders: [english("signin")],
  render: (_, { loaded }) => (
    <AuthPage mode="signin" locale="en" t={loaded.t} />
  ),
  parameters: { msw: { handlers: [json("/api/auth/get-session", null)] } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const EmailOnly: Story = {
  parameters: {
    msw: {
      handlers: [
        json("/api/auth/get-session", null),
        json("/api/auth/providers", { google: false, github: false }),
      ],
    },
  },
};
export const WithOidc: Story = {
  parameters: {
    msw: {
      handlers: [
        json("/api/auth/get-session", null),
        json("/api/auth/providers", {
          google: true,
          github: true,
          emailAndPassword: true,
          oidc: { providerId: "oidc", name: "Pocket ID" },
        }),
      ],
    },
  },
};
export const OidcOnly: Story = {
  parameters: {
    msw: {
      handlers: [
        json("/api/auth/get-session", null),
        json("/api/auth/providers", {
          google: false,
          github: false,
          emailAndPassword: false,
          oidc: { providerId: "oidc", name: "Pocket ID" },
        }),
      ],
    },
  },
};
export const SocialError: Story = {
  parameters: { query: { error: "access_denied" } },
};
const submit: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByLabelText("Email"), "alex@example.com");
  await userEvent.type(canvas.getByLabelText("Password"), "example-password");
  await userEvent.click(canvas.getByRole("button", { name: "Sign In" }));
};
export const Submitting: Story = {
  parameters: {
    msw: {
      handlers: [
        json("/api/auth/get-session", null),
        http.post("*/api/auth/sign-in/email", async () => {
          await delay("infinite");
        }),
      ],
    },
  },
  play: submit,
};
export const Error: Story = {
  parameters: {
    msw: {
      handlers: [
        json("/api/auth/get-session", null),
        http.post("*/api/auth/sign-in/email", () =>
          HttpResponse.json(
            { message: "Invalid email or password." },
            { status: 400 },
          ),
        ),
      ],
    },
  },
  play: submit,
};
export const VerificationRequired: Story = {
  parameters: {
    msw: {
      handlers: [
        json("/api/auth/get-session", null),
        http.post("*/api/auth/sign-in/email", () =>
          HttpResponse.json(
            { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
            { status: 403 },
          ),
        ),
      ],
    },
  },
  play: submit,
};
