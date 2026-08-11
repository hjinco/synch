const MIN_VAULT_PASSWORD_LENGTH = 12;
const MAX_VAULT_PASSWORD_LENGTH = 256;

const COMMON_WEAK_PASSWORDS = new Set([
  "123456",
  "123456789",
  "1234567890",
  "password",
  "password1",
  "password123",
  "qwerty",
  "qwerty123",
  "letmein",
  "admin",
  "welcome",
  "iloveyou",
  "vault",
  "vaultpassword",
  "synch",
  "synchpassword",
  "obsidian",
  "obsidianvault",
  "obsidianvaultpassword",
  "synchvaultpassword",
]);

const WEAK_PASSWORD_TOKENS = [
  "password",
  "qwerty",
  "letmein",
  "admin",
  "welcome",
  "iloveyou",
  "vault",
  "synch",
  "obsidian",
];

export type VaultPasswordValidation =
  | { ok: true }
  | {
      ok: false;
      code:
        | "required"
        | "outer_spaces"
        | "min_length"
        | "max_length"
        | "too_weak"
        | "repeated_character"
        | "simple_sequence";
      count?: number;
      message: string;
    };

export function validateVaultPassword(password: string): VaultPasswordValidation {
  if (!password) {
    return { ok: false, code: "required", message: "Password is required." };
  }

  if (password !== password.trim()) {
    return {
      ok: false,
      code: "outer_spaces",
      message: "Password cannot start or end with spaces.",
    };
  }

  if (password.length < MIN_VAULT_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: "min_length",
      count: MIN_VAULT_PASSWORD_LENGTH,
      message: `Password must be at least ${MIN_VAULT_PASSWORD_LENGTH} characters.`,
    };
  }

  if (password.length > MAX_VAULT_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: "max_length",
      count: MAX_VAULT_PASSWORD_LENGTH,
      message: `Password must be ${MAX_VAULT_PASSWORD_LENGTH} characters or fewer.`,
    };
  }

  if (isCommonWeakPassword(password)) {
    return {
      ok: false,
      code: "too_weak",
      message: "Password is too easy to guess. Use a longer passphrase.",
    };
  }

  if (isSingleCharacterRepeated(password)) {
    return {
      ok: false,
      code: "repeated_character",
      message: "Password cannot be one repeated character.",
    };
  }

  if (isSimpleSequence(password)) {
    return {
      ok: false,
      code: "simple_sequence",
      message: "Password cannot be a simple sequence.",
    };
  }

  return { ok: true };
}

function isSingleCharacterRepeated(value: string): boolean {
  return new Set(value.toLowerCase()).size === 1;
}

function isCommonWeakPassword(value: string): boolean {
  let compactLower = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (COMMON_WEAK_PASSWORDS.has(compactLower)) {
    return true;
  }

  for (const token of WEAK_PASSWORD_TOKENS) {
    compactLower = compactLower.split(token).join("");
  }

  return compactLower === "" || /^[0-9]+$/.test(compactLower);
}

function isSimpleSequence(value: string): boolean {
  if (!/^[a-z]+$/i.test(value) && !/^[0-9]+$/.test(value)) {
    return false;
  }

  const lower = value.toLowerCase();
  const direction = lower.charCodeAt(1) - lower.charCodeAt(0);
  if (direction !== 1 && direction !== -1) {
    return false;
  }

  for (let index = 1; index < lower.length; index += 1) {
    if (lower.charCodeAt(index) - lower.charCodeAt(index - 1) !== direction) {
      return false;
    }
  }

  return true;
}
