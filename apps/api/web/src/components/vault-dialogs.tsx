import { useState, type SubmitEvent } from "react";
import { BusyButton, Modal } from "./common";
import { ApiError, request } from "../lib/api";
import type { Translator } from "../lib/i18n";
import type { Vault } from "../pages/vaults";

export const loadVaultCrypto = () => import("../../vendor/vault-crypto.js");
const passwordErrors = {
  required: "passwordRequired",
  outer_spaces: "passwordOuterSpaces",
  min_length: "passwordMinLength",
  max_length: "passwordMaxLength",
  too_weak: "passwordTooWeak",
  repeated_character: "passwordRepeatedCharacter",
  simple_sequence: "passwordSimpleSequence",
} as const;
interface DialogProps {
  t: Translator<"vaults">;
  onClose: () => void;
  onSuccess: (name: string) => void;
}
export function CreateVaultDialog({
  t,
  organizationId,
  onClose,
  onSuccess,
}: DialogProps & { organizationId: string }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("nameRequired"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      let vaultCrypto: Awaited<ReturnType<typeof loadVaultCrypto>>;
      try {
        vaultCrypto = await loadVaultCrypto();
      } catch {
        setError(t("cryptoLoadFailed"));
        return;
      }
      const validation = vaultCrypto.validateVaultPassword(password);
      if (!validation.ok) {
        setError(
          t(passwordErrors[validation.code], { count: validation.count ?? "" }),
        );
        return;
      }
      if (password !== confirmation) {
        setError(t("passwordMismatch"));
        return;
      }
      // Production-strength Argon2id and key wrapping run only in the browser.
      const { envelope, remoteVaultKey } =
        await vaultCrypto.createPasswordWrappedRemoteVaultKey(password);
      remoteVaultKey.fill(0);
      await request("/v1/vaults", {
        method: "POST",
        fallback: t("unableToCreateVault"),
        body: {
          name: trimmedName,
          organizationId,
          initialWrapper: { kind: "password", envelope },
        },
      });
      setPassword("");
      setConfirmation("");
      onSuccess(trimmedName);
    } catch (error) {
      setError(error instanceof ApiError ? error.message : t("apiUnavailable"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      id="create-dialog"
      title={t("createTitle")}
      busy={busy}
      onClose={onClose}
    >
      <form onSubmit={(event) => { void submit(event); }}>
        <div className="dialog-body">
          <h2 className="dialog-title">{t("createTitle")}</h2>
          <p className="dialog-intro">{t("createIntro")}</p>
          <div className="dialog-fields">
            <div className="field">
              <label className="label" htmlFor="create-name">
                {t("createNameLabel")}
              </label>
              <input
                id="create-name"
                className="input"
                autoComplete="off"
                autoFocus
                value={name}
                disabled={busy}
                onChange={(event) => {
                  setName(event.target.value);
                  setError("");
                }}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="create-password">
                {t("createPasswordLabel")}
              </label>
              <input
                id="create-password"
                className="input"
                type="password"
                autoComplete="new-password"
                value={password}
                disabled={busy}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError("");
                }}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="create-password-confirm">
                {t("createConfirmPasswordLabel")}
              </label>
              <input
                id="create-password-confirm"
                className="input"
                type="password"
                autoComplete="new-password"
                value={confirmation}
                disabled={busy}
                onChange={(event) => {
                  setConfirmation(event.target.value);
                  setError("");
                }}
              />
            </div>
            {error && (
              <p id="create-error" className="form-error" role="alert">
                {error}
              </p>
            )}
            <p className="form-hint">{t("createPasswordHint")}</p>
          </div>
        </div>
        <div className="dialog-footer">
          <button
            type="button"
            className="btn btn--secondary"
            disabled={busy}
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <BusyButton
            busy={busy}
            id="confirm-create"
            type="submit"
            className="btn btn--primary"
            disabled={busy || !name.trim() || !password || !confirmation}
          >
            {t(busy ? "creating" : "createConfirm")}
          </BusyButton>
        </div>
      </form>
    </Modal>
  );
}
export function DeleteVaultDialog({
  t,
  vault,
  onClose,
  onSuccess,
}: DialogProps & { vault: Vault }) {
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || confirmation !== vault.name) return;
    setBusy(true);
    setError("");
    try {
      await request(`/v1/vaults/${encodeURIComponent(vault.id)}`, {
        method: "DELETE",
        fallback: t("unableToDeleteVault"),
      });
      onSuccess(vault.name);
    } catch (error) {
      setError(error instanceof ApiError ? error.message : t("apiUnavailable"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      id="delete-dialog"
      title={t("deleteTitle")}
      busy={busy}
      onClose={onClose}
    >
      <form onSubmit={(event) => { void submit(event); }}>
        <div className="dialog-body">
          <h2 className="dialog-title">{t("deleteTitle")}</h2>
          <p className="dialog-intro">
            {t("deleteCopy", { name: vault.name })}
          </p>
          <div className="field">
            <label htmlFor="confirm-name" className="label">
              {t("confirmLabel")}
            </label>
            <input
              id="confirm-name"
              className="input"
              autoComplete="off"
              autoFocus
              disabled={busy}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <button
            type="button"
            className="btn btn--secondary"
            disabled={busy}
            onClick={onClose}
          >
            {t("cancel")}
          </button>
          <BusyButton
            busy={busy}
            id="confirm-delete"
            type="submit"
            className="btn btn--danger"
            disabled={busy || confirmation !== vault.name}
          >
            {t(busy ? "deleting" : "deletePermanently")}
          </BusyButton>
        </div>
      </form>
    </Modal>
  );
}
