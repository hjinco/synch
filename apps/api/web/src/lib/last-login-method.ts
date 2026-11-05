type LoginMethod = "email" | "google" | "github" | "oidc";

export function readLastLoginMethod(): LoginMethod | null {
  // Written only after successful authentication by Better Auth's plugin.
  const prefix = "better-auth.last_used_login_method=";
  const value = document.cookie.split(";").map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(prefix))?.slice(prefix.length);
  return value === "email" || value === "google" || value === "github" || value === "oidc" ? value : null;
}
