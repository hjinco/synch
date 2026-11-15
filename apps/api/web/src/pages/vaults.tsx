import { VaultActions } from "../components/vault-actions";
import { VaultIcon } from "../components/vault-icon";
import { VaultSetup } from "../components/vault-setup";
import { AccountMenu } from "../components/account-menu";
import { ManagementHeader } from "../components/management-header";
import { useCallback, useEffect, useRef, useState } from "react";
import { Brand, LoadingSkeleton, Modal, Status, type StatusValue } from "../components/common";
import {
  CreateVaultDialog,
  DeleteVaultDialog,
  loadVaultCrypto,
} from "../components/vault-dialogs";
import { ApiError, getSession, request, signOut, type User } from "../lib/api";
import { localUrl, signIn } from "../lib/navigation";
import {
  canManage,
  organizationPath,
  type Organization,
  type OrganizationSummary,
} from "../lib/organizations";
import type { PageProps } from "../lib/i18n";

export interface Vault {
  id: string;
  name: string;
  organizationId: string;
  createdAt: string;
  deletionStatus?: string | null;
  deletionError?: string | null;
}
const isDeleting = (vault: Vault) =>
  vault.deletionStatus === "queued" || vault.deletionStatus === "running";
export function VaultsPage({ t, locale }: PageProps<"vaults">) {
  const [user, setUser] = useState<User | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<StatusValue>({ message: "" });
  const [creating, setCreating] = useState<OrganizationSummary | null>(null);
  const [deleting, setDeleting] = useState<Vault | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  const loadVaults = useCallback(
    async (successMessage?: string, background = false) => {
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      const options = {
        fallback: t("unableToLoadVaults"),
        signal: controller.signal,
      };
      setLoading(true);
      if (!background) setStatus({ message: "" });
      try {
        const result = await request<{ organizations: OrganizationSummary[] }>(
          "/v1/organizations",
          options,
        );
        if (controller.signal.aborted) return;
        const visible = result.organizations.filter(canManage);

        const details = await Promise.all(
          visible.map((item) => request<Organization>(organizationPath(item.id), options)),
        );
        if (controller.signal.aborted) return;
        const managed = details.filter(canManage);
        let items: Vault[] = [];
        if (managed.length > 0) {
          const result = await request<{ vaults: Vault[] }>(
            "/v1/vaults?includeDeleting=true",
            options,
          );
          if (controller.signal.aborted) return;
          const managedIds = new Set(managed.map((item) => item.id));
          items = result.vaults.filter((vault) => managedIds.has(vault.organizationId));
        }
        setOrganizations(managed);
        setVaults(items);
        setLoaded(true);
        setRefreshRequired(false);
        setStatus({
          message: successMessage ?? "",
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          if (successMessage) setRefreshRequired(true);
          setStatus({
            message:
              successMessage
                ? `${successMessage} ${t("refreshFailed")}`
                : error instanceof ApiError ? error.message : t("apiUnavailable"),
            tone: "error",
          });
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [t],
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setStatus({ message: "" });
    void getSession(t("apiUnavailable"), controller.signal)
      .then(async (session) => {
        if (controller.signal.aborted) return;
        if (!session?.user) {
          signIn(locale);
          return;
        }
        setUser(session.user);
        await loadVaults();
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setStatus({ message: t("apiUnavailable"), tone: "error" });
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      activeRequest.current?.abort();
    };
  }, [t, locale, loadVaults, retry]);
  useEffect(() => {
    if (loading || creating || deleting || connecting !== null || !vaults.some(isDeleting)) return;
    const timer = window.setTimeout(() => void loadVaults(undefined, true), 2500);
    return () => window.clearTimeout(timer);
  }, [vaults, loading, creating, deleting, connecting, loadVaults]);
  useEffect(() => {
    // Returning from Obsidian can add a vault created in the plugin.
    if (!loaded || loading || creating || deleting || connecting !== null) return;
    const refreshOnReturn = () => void loadVaults(undefined, true);
    window.addEventListener("focus", refreshOnReturn);
    return () => window.removeEventListener("focus", refreshOnReturn);
  }, [loaded, loading, creating, deleting, connecting, loadVaults]);
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await signOut(t("unableToSignOut"));
      signIn(locale);
    } catch (error) {
      setStatus({
        message:
          error instanceof ApiError ? error.message : t("apiUnavailable"),
        tone: "error",
      });
      setLoggingOut(false);
    }
  }
  const firstVault = loaded && organizations.length > 0 && vaults.length === 0;
  const showSkeleton = loading && !loaded;
  function createdDate(vault: Vault) {
    const date = new Date(vault.createdAt);
    const formatted = Number.isNaN(date.getTime())
      ? t("unknown")
      : new Intl.DateTimeFormat(locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
        }).format(date);
    return t("created", { date: formatted });
  }
  return (
    <>
      <main className={`page page--wide management-page vaults-page${firstVault ? " vaults-page--empty" : ""}`}>
        <div className="topbar management-topbar">
          <Brand />
          {user && (
            <AccountMenu user={user} t={t} busy={loggingOut} onSignOut={() => void logout()} />
          )}
        </div>
        <ManagementHeader title={t(firstVault ? "setupTitle" : "title")} subtitle={firstVault ? t("setupIntro") : undefined}>
          {status.message && <div className="management-header-feedback">
            {(!firstVault || status.tone || loading) && <Status {...status} className="status--bar" />}
            {status.tone === "error" && !loading && (
              <button
                type="button"
                className="management-link"
                onClick={() => user ? void loadVaults() : setRetry((value) => value + 1)}
              >
                {t("retry")}
              </button>
            )}
          </div>}
        </ManagementHeader>
        {firstVault && <VaultSetup t={t} email={user?.email ?? ""} />}
        {!firstVault && <section id="vault-list" className="vault-list" aria-busy={loading}>
          {showSkeleton && <LoadingSkeleton />}
          {!showSkeleton && organizations.map((organization) => {
            const organizationVaults = vaults.filter((vault) => vault.organizationId === organization.id);
            return (
              <section key={organization.id} className="vault-organization" aria-labelledby={`organization-${organization.id}`}>
                <div className="vault-organization-header">
                  <h2 id={`organization-${organization.id}`} className="vault-organization-name">
                    <a className="vault-organization-link" title={t("manageOrganization", { name: organization.name })} href={localUrl("/organizations", locale, { organizationId: organization.id })}>
                      <span>{organization.name}</span>
                      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M7 17 17 7M7 7h10v10" />
                      </svg>
                    </a>
                  </h2>
                  <div className="vault-organization-actions">
                    <button
                      id={`create-vault-${organization.id}`}
                      type="button"
                      className="btn btn--primary btn--compact"
                      disabled={loading || refreshRequired || !canManage(organization)}
                      onClick={() => {
                        setCreating(organization);
                        void loadVaultCrypto().catch(() => {});
                      }}
                    >
                      <span aria-hidden="true">＋</span> {t("createVault")}
                    </button>
                  </div>
                </div>
                <div className="vault-list">
                  {organizationVaults.map((vault) => (
                    <article key={vault.id} className={`vault-card${vault.deletionStatus === "failed" ? " vault-card--failed" : ""}`}>
                      <VaultIcon />
                      <div className="vault-info">
                        <h3 className="vault-name">{vault.name}</h3>
                        <p className="vault-meta">{createdDate(vault)}</p>
                        {vault.deletionStatus && (
                          <p className={`vault-deletion-status access-status ${vault.deletionStatus === "failed" ? "access-status--revoked" : "access-status--pending_key"}`}>
                            {t("deletionStatus", { status: vault.deletionStatus })}
                          </p>
                        )}
                        {vault.deletionError && (
                          <p className="form-error">{vault.deletionError}</p>
                        )}
                      </div>
                      {canManage(organization) && (
                        <VaultActions
                          name={vault.name}
                          t={t}
                          disabled={loading || refreshRequired || isDeleting(vault)}
                          onDelete={() => setDeleting(vault)}
                        />
                      )}
                    </article>
                  ))}
                  {!organizationVaults.length && <p className="vault-organization-empty">{t("emptyOrganization")}</p>}
                </div>
              </section>
            );
          })}
        </section>}
        {loaded && !showSkeleton && !organizations.length && (
          <div className="vaults-access-empty">
            <h2 className="empty-guide-title">{t("noManagedOrganization")}</h2>
            <p>{t("noManagedOrganizationHelp")}</p>
          </div>
        )}
      </main>
      {creating && (
        <CreateVaultDialog
          t={t}
          organizationId={creating.id}
          onClose={() => setCreating(null)}
          onSuccess={(name) => {
            setCreating(null);
            setConnecting(name);
            void loadVaults(t("createdVault", { name }));
          }}
        />
      )}
      {connecting !== null && (
        <Modal id="connect-guide" busy={false} title={t("setupConnectTitle", { name: connecting })} onClose={() => setConnecting(null)}>
          <div className="dialog-body">
            <h2 className="dialog-title">{t("setupConnectTitle", { name: connecting })}</h2>
            <p className="vault-setup-intro">{t("setupConnectIntro")}</p>
            <VaultSetup t={t} email={user?.email ?? ""} vaultName={connecting} />
          </div>
          <div className="dialog-footer">
            <button type="button" className="btn btn--secondary btn--compact" onClick={() => setConnecting(null)}>{t("setupClose")}</button>
          </div>
        </Modal>
      )}
      {deleting && (
        <DeleteVaultDialog
          t={t}
          vault={deleting}
          onClose={() => setDeleting(null)}
          onSuccess={(name) => {
            setDeleting(null);
            void loadVaults(t("queuedForDeletion", { name }));
          }}
        />
      )}
    </>
  );
}
