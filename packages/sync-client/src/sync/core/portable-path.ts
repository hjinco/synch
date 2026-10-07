/**
 * The subset of vault paths that can be created by Obsidian on every
 * supported desktop platform. Keep this independent of a host adapter: the
 * server cannot inspect encrypted metadata, so every client must reach the
 * same decision before publishing a path.
 */
export type PortablePathViolationCode =
  | "empty_path"
  | "empty_component"
  | "dot_component"
  | "windows_reserved_character"
  | "windows_control_character"
  | "windows_trailing_space_or_dot"
  | "windows_reserved_name";

export interface PortablePathViolation {
  code: PortablePathViolationCode;
  component: string | null;
  componentIndex: number | null;
}

const WINDOWS_RESERVED_CHARACTERS = /[<>:"\\|?*]/;
// eslint-disable-next-line no-control-regex -- Reject the control characters forbidden in Windows filenames.
const WINDOWS_CONTROL_CHARACTERS = /[\u0000-\u001f]/;
const WINDOWS_TRAILING_SPACE_OR_DOT = /[ .]$/;
const WINDOWS_DEVICE_NAME =
  /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[\d¹²³]|LPT[\d¹²³]) *(?:\..*)?$/i;

export function validatePortableVaultPath(path: string): PortablePathViolation[] {
  if (!path) {
    return [{ code: "empty_path", component: null, componentIndex: null }];
  }

  const violations: PortablePathViolation[] = [];
  for (const [componentIndex, component] of path.split("/").entries()) {
    if (!component) {
      violations.push({ code: "empty_component", component, componentIndex });
      continue;
    }
    if (component === "." || component === "..") {
      violations.push({ code: "dot_component", component, componentIndex });
    }
    if (WINDOWS_RESERVED_CHARACTERS.test(component)) {
      violations.push({
        code: "windows_reserved_character",
        component,
        componentIndex,
      });
    }
    if (WINDOWS_CONTROL_CHARACTERS.test(component)) {
      violations.push({
        code: "windows_control_character",
        component,
        componentIndex,
      });
    }
    if (WINDOWS_TRAILING_SPACE_OR_DOT.test(component)) {
      violations.push({
        code: "windows_trailing_space_or_dot",
        component,
        componentIndex,
      });
    }
    if (WINDOWS_DEVICE_NAME.test(component)) {
      violations.push({
        code: "windows_reserved_name",
        component,
        componentIndex,
      });
    }
  }
  return violations;
}

export function isPortableVaultPath(path: string): boolean {
  return validatePortableVaultPath(path).length === 0;
}
