import { useEffect, useState, type SubmitEvent } from "react";
import { PageHeader, Status, type StatusValue } from "../components/common";
import { ProviderIcon } from "../components/provider-icon";
import { ApiError, getSession, request } from "../lib/api";
import { authReturnTo, localUrl } from "../lib/navigation";
import type { PageProps } from "../lib/i18n";
import { readLastLoginMethod } from "../lib/last-login-method";

const socialProviders = [
  { id: "google", label: "continueWithGoogle" },
  { id: "github", label: "continueWithGitHub" },
] as const;
type SocialProvider = (typeof socialProviders)[number]["id"];

export function AuthPage({
  mode,
  t,
  locale,
}: PageProps<"signin" | "signup"> & { mode: "signin" | "signup" }) {
  const signup = mode === "signup";
  const [returnTo] = useState(() => authReturnTo(locale));
  const [lastLoginMethod] = useState(readLastLoginMethod);
  const [busy, setBusy] = useState(false);
  const [enabledProviders, setEnabledProviders] = useState({ google: false, github: false });
  const [status, setStatus] = useState<StatusValue>(() => ({
    message: new URLSearchParams(location.search).has("error")
      ? t("socialFailed")
      : "",
    tone: "error",
  }));
  const [verificationEmail, setVerificationEmail] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [resending, setResending] = useState(false);
  const [resendStatus, setResendStatus] = useState<StatusValue>({
    message: "",
  });
  useEffect(() => {
    const controller = new AbortController();
    void request<Record<SocialProvider, boolean>>("/api/auth/providers", {
      fallback: t("requestFailed"),
      redirectUnauthorized: false,
      signal: controller.signal,
    })
      .then((providers) => {
        if (!controller.signal.aborted) setEnabledProviders({
          google: providers?.google === true,
          github: providers?.github === true,
        });
      })
      .catch(() => {
        // Email authentication remains available if provider discovery fails.
      });
    return () => controller.abort();
  }, [t]);
  useEffect(() => {
    if (signup) return;
    const controller = new AbortController();
    void getSession(t("requestFailed"), controller.signal)
      .then((session) => {
        if (!controller.signal.aborted && session?.user)
          location.assign(returnTo);
      })
      .catch(() => {
        /* Explicit submission surfaces connectivity errors. */
      });
    return () => controller.abort();
  }, [signup, returnTo, t]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  function verify(email: string) {
    setVerificationEmail(email);
    setStatus({ message: "" });
    setCooldown(30);
  }
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || verificationEmail) return;
    const body = Object.fromEntries(
      new FormData(event.currentTarget).entries(),
    );
    const email = typeof body.email === "string" ? body.email : "";
    setBusy(true);
    setStatus({ message: t(signup ? "creatingAccount" : "loggingIn") });
    try {
      const result = await request<{ token?: string | null }>(
        `/api/auth/${signup ? "sign-up" : "sign-in"}/email`,
        {
          method: "POST",
          body: { ...body, callbackURL: returnTo },
          redirectUnauthorized: false,
          fallback: t(signup ? "accountCreationFailed" : "authFailed"),
        },
      );
      if (signup && result?.token === null) {
        verify(email);
        return;
      }
      setStatus({
        message: t(signup ? "createdRedirecting" : "loggedInRedirecting"),
      });
      location.assign(returnTo);
    } catch (error) {
      if (error instanceof ApiError) {
        if (
          !signup &&
          (error.code === "EMAIL_NOT_VERIFIED" ||
            /verify|verified/i.test(error.message))
        )
          verify(email);
        else
          setStatus({
            message:
              error.code === "SIGN_UP_EMAIL_NOT_ALLOWED"
                ? t("emailNotAllowed")
                : error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
                  ? t("alreadyRegistered")
                  : error.message,
            tone: "error",
          });
      } else setStatus({ message: t("apiUnavailableWithHint"), tone: "error" });
    } finally {
      setBusy(false);
    }
  }
  async function signInWithSocialProvider(provider: SocialProvider) {
    if (busy || !enabledProviders[provider]) return;
    setBusy(true);
    setStatus({ message: "" });
    try {
      const result = await request<{ url: string }>("/api/auth/sign-in/social", {
        method: "POST",
        body: {
          provider,
          callbackURL: returnTo,
          errorCallbackURL: localUrl(signup ? "/signup" : "/signin", locale, {
            return_to: returnTo,
          }),
          disableRedirect: true,
        },
        redirectUnauthorized: false,
        fallback: t("socialFailed"),
      });
      if (!result?.url) throw new Error("Missing authorization URL");
      location.assign(result.url);
    } catch {
      setStatus({ message: t("socialFailed"), tone: "error" });
      setBusy(false);
    }
  }
  async function resend() {
    if (resending || cooldown || !verificationEmail) return;
    setResending(true);
    setResendStatus({ message: t("sending") });
    try {
      await request("/api/auth/send-verification-email", {
        method: "POST",
        body: { email: verificationEmail, callbackURL: returnTo },
        fallback: t("failedToResend"),
        redirectUnauthorized: false,
      });
      setResendStatus({ message: t("resent") });
      setCooldown(30);
    } catch (error) {
      setResendStatus({
        message:
          error instanceof ApiError ? error.message : t("apiUnavailable"),
        tone: "error",
      });
    } finally {
      setResending(false);
    }
  }
  const disabled = busy || Boolean(verificationEmail);
  return (
    <div className="page page--narrow">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <form
        id={signup ? "sign-up-form" : "sign-in-form"}
        className="form"
        onSubmit={(event) => { void submit(event); }}
      >
        {socialProviders.filter(({ id }) => enabledProviders[id]).map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className="btn btn--secondary btn--social btn--block"
            disabled={busy}
            onClick={() => void signInWithSocialProvider(id)}
          >
            <ProviderIcon provider={id} />
            <span>
              {t(label)}
              {lastLoginMethod === id && <>{" "}<span className="login-method-badge">{t("lastUsed")}</span></>}
            </span>
          </button>
        ))}
        {signup && (
          <div className="field">
            <label htmlFor="name" className="label">
              {t("name")}
            </label>
            <input
              id="name"
              name="name"
              required
              autoComplete="name"
              className="input"
              placeholder="John Doe"
              disabled={disabled}
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="email" className="label">
            {t("email")}
          </label>
          <input
            type="email"
            id="email"
            name="email"
            required
            autoComplete="email"
            className="input"
            placeholder="you@example.com"
            disabled={disabled}
          />
        </div>
        <div className="field">
          <label htmlFor="password" className="label">
            {t("password")}
          </label>
          <input
            type="password"
            id="password"
            name="password"
            required
            autoComplete={signup ? "new-password" : "current-password"}
            className="input"
            placeholder="••••••••"
            disabled={disabled}
          />
        </div>
        <Status {...status} />
        <button
          type="submit"
          disabled={disabled}
          className={`btn btn--primary btn--block ${verificationEmail ? "btn--muted" : ""}`}
        >
          {t(
            verificationEmail
              ? signup
                ? "emailSent"
                : "verificationRequiredButton"
              : "submit",
          )}
          {!signup && lastLoginMethod === "email" && <>{" "}<span className="login-method-badge">{t("lastUsed")}</span></>}
        </button>
        {verificationEmail && (
          <div id="success-container" className="success-panel">
            <div className="success-title">
              {t(signup ? "checkEmail" : "verificationRequired")}
            </div>
            <div className="success-body">
              {signup ? (
                <>
                  {t("sentPrefix")}{" "}
                  <span className="sent-email">{verificationEmail}</span>
                  {t("sentSuffix")}
                </>
              ) : (
                t("checkInbox")
              )}
            </div>
            <div className="resend">
              <button
                id="resend-button"
                type="button"
                className="link-button"
                disabled={resending || cooldown > 0}
                onClick={() => void resend()}
              >
                {cooldown
                  ? t("resendAvailableIn", { seconds: cooldown })
                  : t("resendVerification")}
              </button>
              <Status
                {...resendStatus}
                id="resend-message"
                className="resend-message"
              />
            </div>
          </div>
        )}
      </form>
      <div className="auth-footer">
        {t(signup ? "hasAccount" : "noAccount")}{" "}
        <a
          href={localUrl(signup ? "/signin" : "/signup", locale, {
            return_to: returnTo,
          })}
        >
          {t(signup ? "signIn" : "signUp")}
        </a>
      </div>
    </div>
  );
}
