import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { translator } from "../lib/i18n";
import { AuthPage } from "./auth";

const json = (value: unknown, status = 200) => Promise.resolve(Response.json(value, { status }));

afterEach(() => {
  document.cookie = "better-auth.last_used_login_method=; Max-Age=0; Path=/";
});

describe.each([{ provider: "google", name: "Google" }, { provider: "github", name: "GitHub" }])("$name sign-in", ({ provider, name }) => {
  it.each([false, "unavailable"])("hides the provider when provider discovery is %s", async (availability) => {
    const fetchMock = vi.fn(() => availability === false ? json({ google: false, github: false }) : json({}, 503));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => {
      render(<AuthPage mode="signup" t={await translator("signup", "en")} locale="en" />);
    });
    expect(screen.queryByRole("button", { name: `Continue with ${name}` })).toBeNull();
    expect((screen.getByRole("button", { name: "Create Account" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(["signin", "signup"] as const)("starts the provider from %s without email fields and recovers after failure", async (mode) => {
    history.replaceState(null, "", `/${mode}?return_to=${encodeURIComponent("/device?user_code=ABCD&return_uri=obsidian%3A%2F%2Fsynch-device-login")}`);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("providers")) return json({ [provider]: true });
      if (String(input).endsWith("get-session")) return json(null);
      return json({ message: "Failed" }, 503);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthPage mode={mode} t={await translator(mode, "en")} locale="ko" />);
    await userEvent.click(await screen.findByRole("button", { name: `Continue with ${name}` }));
    await screen.findByText("Social sign-in failed or was canceled. Please try again.");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-in/social", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        provider,
        callbackURL: "http://localhost:3000/device?user_code=ABCD&return_uri=obsidian%3A%2F%2Fsynch-device-login",
        errorCallbackURL: `http://localhost:3000/${mode}?lang=ko&return_to=http%3A%2F%2Flocalhost%3A3000%2Fdevice%3Fuser_code%3DABCD%26return_uri%3Dobsidian%253A%252F%252Fsynch-device-login`,
        disableRedirect: true,
      }),
    })));
    expect((screen.getByRole("button", { name: `Continue with ${name}` }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a safe error message after an OAuth callback failure", async () => {
    history.replaceState(null, "", "/signup?error=access_denied&error_description=untrusted-text");
    vi.stubGlobal("fetch", vi.fn(() => json({ [provider]: true })));
    render(<AuthPage mode="signup" t={await translator("signup", "en")} locale="en" />);
    expect(screen.getByText("Social sign-in failed or was canceled. Please try again.")).toBeTruthy();
    expect(screen.queryByText("untrusted-text")).toBeNull();
    await screen.findByRole("button", { name: `Continue with ${name}` });
  });
});

it("offers both configured providers and blocks duplicate submissions while signing in", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  const fetchMock = vi.fn((input: RequestInfo | URL) =>
    String(input).endsWith("providers") ? json({ google: true, github: true }) : pending,
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<AuthPage mode="signup" t={await translator("signup", "en")} locale="en" />);
  const github = await screen.findByRole("button", { name: "Continue with GitHub" });
  const google = screen.getByRole("button", { name: "Continue with Google" });
  await userEvent.click(github);
  expect((github as HTMLButtonElement).disabled).toBe(true);
  expect((google as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(google);
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("sign-in/social"))).toHaveLength(1);
  await act(async () => finish(Response.json({}, { status: 503 })));
  expect((github as HTMLButtonElement).disabled).toBe(false);
  expect((google as HTMLButtonElement).disabled).toBe(false);
});

it("shows a duplicate signup error without claiming a verification email was sent", async () => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input).endsWith("providers")
    ? json({ google: true, github: true })
    : json({ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", message: "Server duplicate error" }, 422),
  ));
  render(<AuthPage mode="signup" t={await translator("signup", "en")} locale="en" />);
  await userEvent.type(screen.getByLabelText("Name"), "Existing User");
  await userEvent.type(screen.getByLabelText("Email"), "owner@example.com");
  await userEvent.type(screen.getByLabelText("Password"), "password-123");
  await userEvent.click(screen.getByRole("button", { name: "Create Account" }));
  await screen.findByText("This email is already registered. Please sign in with your existing login method.");
  expect(screen.queryByText("Check your email")).toBeNull();
  expect(screen.queryByRole("button", { name: "Email Sent" })).toBeNull();
  expect((screen.getByRole("button", { name: "Create Account" }) as HTMLButtonElement).disabled).toBe(false);
});

describe("last used login method", () => {
  it.each([
    { method: "email", button: "Sign In" },
    { method: "google", button: "Continue with Google" },
    { method: "github", button: "Continue with GitHub" },
  ])("marks only the last successful $method method", async ({ method, button }) => {
    document.cookie = `better-auth.last_used_login_method=${method}; Path=/`;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input).endsWith("providers")
      ? json({ google: true, github: true }) : json(null),
    ));
    render(<AuthPage mode="signin" t={await translator("signin", "en")} locale="en" />);
    const marked = await screen.findByRole("button", { name: `${button} Last used` });
    expect(within(marked).getByText("Last used")).toBeTruthy();
    expect(screen.getAllByText("Last used")).toHaveLength(1);
  });

  it.each(["", "unknown", "google"])("does not show a hint for absent, unknown, or disabled methods (%s)", async (method) => {
    document.cookie = `better-auth.last_used_login_method=${method}; Path=/`;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input).endsWith("providers")
      ? json({ google: false, github: true }) : json(null),
    ));
    render(<AuthPage mode="signin" t={await translator("signin", "en")} locale="en" />);
    await screen.findByRole("button", { name: "Continue with GitHub" });
    expect(screen.queryByText("Last used")).toBeNull();
  });

  it("keeps the previous method when a different provider fails", async () => {
    document.cookie = "better-auth.last_used_login_method=google; Path=/";
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("providers")) return json({ google: true, github: true });
      if (String(input).endsWith("get-session")) return json(null);
      return json({}, 503);
    }));
    render(<AuthPage mode="signin" t={await translator("signin", "en")} locale="en" />);
    await userEvent.click(await screen.findByRole("button", { name: "Continue with GitHub" }));
    await screen.findByText("Social sign-in failed or was canceled. Please try again.");
    expect(screen.getByRole("button", { name: "Continue with Google Last used" })).toBeTruthy();
    expect(document.cookie).toContain("better-auth.last_used_login_method=google");
  });
});

describe("OIDC sign-in", () => {
  const oidcProviders = (overrides: Record<string, unknown> = {}) => ({
    google: false,
    github: false,
    emailAndPassword: true,
    oidc: { providerId: "oidc", name: "Pocket ID" },
    ...overrides,
  });

  it.each(["signin", "signup"] as const)("starts the configured provider from %s through social sign-in", async (mode) => {
    history.replaceState(null, "", `/${mode}?return_to=${encodeURIComponent("/device?user_code=ABCD")}`);
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("providers")) return json(oidcProviders());
      if (String(input).endsWith("get-session")) return json(null);
      return json({ message: "Failed" }, 503);
    });
    vi.stubGlobal("fetch", fetchMock);
    const t = await translator(mode, "en");
    render(<AuthPage mode={mode} t={t} locale="en" />);
    await userEvent.click(await screen.findByRole("button", { name: t("continueWithProvider", { name: "Pocket ID" }) }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/auth/sign-in/social", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        provider: "oidc",
        callbackURL: "http://localhost:3000/device?user_code=ABCD",
        errorCallbackURL: `http://localhost:3000/${mode}?lang=en&return_to=http%3A%2F%2Flocalhost%3A3000%2Fdevice%3Fuser_code%3DABCD`,
        disableRedirect: true,
      }),
    })));
  });

  it.each([{ oidc: null }, "unavailable"] as const)("hides the provider when discovery reports %j", async (availability) => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (!String(input).endsWith("providers")) return json(null);
      return availability === "unavailable" ? json({}, 503) : json(oidcProviders(availability));
    }));
    const t = await translator("signin", "en");
    await act(async () => {
      render(<AuthPage mode="signin" t={t} locale="en" />);
    });
    expect(screen.queryByRole("button", { name: t("continueWithProvider", { name: "Pocket ID" }) })).toBeNull();
    expect(screen.getByLabelText(t("password"))).toBeTruthy();
  });

  it.each(["signin", "signup"] as const)("hides the password form on %s when password authentication is disabled", async (mode) => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      String(input).endsWith("providers") ? json(oidcProviders({ emailAndPassword: false })) : json(null),
    ));
    const t = await translator(mode, "en");
    render(<AuthPage mode={mode} t={t} locale="en" />);
    await screen.findByRole("button", { name: t("continueWithProvider", { name: "Pocket ID" }) });
    expect(screen.queryByLabelText(t("email"))).toBeNull();
    expect(screen.queryByLabelText(t("password"))).toBeNull();
    expect(screen.queryByRole("button", { name: t("submit") })).toBeNull();
  });

  it("marks the provider as the last used login method", async () => {
    document.cookie = "better-auth.last_used_login_method=oidc; Path=/";
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) =>
      String(input).endsWith("providers") ? json(oidcProviders()) : json(null),
    ));
    const t = await translator("signin", "en");
    render(<AuthPage mode="signin" t={t} locale="en" />);
    const button = await screen.findByRole("button", { name: `${t("continueWithProvider", { name: "Pocket ID" })} ${t("lastUsed")}` });
    expect(within(button).getByText(t("lastUsed"))).toBeTruthy();
  });

  it.each(["de", "ja", "ko", "zh-cn", "zh-tw"] as const)("translates the provider label for %s", async (locale) => {
    const [english, translated] = await Promise.all([translator("signin", "en"), translator("signin", locale)]);
    const label = translated("continueWithProvider", { name: "Pocket ID" });
    expect(label).toContain("Pocket ID");
    expect(label).not.toBe(english("continueWithProvider", { name: "Pocket ID" }));
  });
});
