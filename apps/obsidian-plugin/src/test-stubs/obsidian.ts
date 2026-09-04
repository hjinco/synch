type RequestUrlMock = (input: unknown) => Promise<unknown>;

let requestUrlMock: RequestUrlMock | null = null;
let language = "en";
const buttonComponents: MockButtonComponent[] = [];
const textComponents: MockTextComponent[] = [];
const toggleComponents: MockToggleComponent[] = [];
const dropdownComponents: MockDropdownComponent[] = [];
const progressBarComponents: MockProgressBarComponent[] = [];
const extraButtonComponents: MockExtraButtonComponent[] = [];
const createdElementTexts: string[] = [];
const markdownRenderCalls: MarkdownRenderCall[] = [];
const settingNames: string[] = [];
const settingDescriptions: string[] = [];
const settingClasses: string[][] = [];
const createdElements: StoredElementRecord[] = [];
const notices: Array<{ message: string; timeout?: number }> = [];

interface CreatedElementRecord {
  tag: string;
  text: string;
  classes: string[];
  attributes: Record<string, string>;
}

interface StoredElementRecord extends CreatedElementRecord {
  removed: boolean;
}

interface MarkdownRenderCall {
  app: unknown;
  markdown: string;
  sourcePath: string;
  component: unknown;
}

class MockElement {
  text = "";
  private readonly eventListeners = new Map<string, Array<() => void>>();

  constructor(private readonly record: StoredElementRecord | null = null) {}

  empty(): void {}

  addClass(value: string): void {
    this.record?.classes.push(value);
  }

  createEl(tag: string, options?: { text?: string; cls?: string }): MockElement {
    return this.createChild(tag, options);
  }

  createSpan(options?: { text?: string; cls?: string }): MockElement {
    return this.createChild("span", options);
  }

  createDiv(options?: { text?: string; cls?: string }): MockElement {
    return this.createChild("div", options);
  }

  private createChild(tag: string, options?: { text?: string; cls?: string }): MockElement {
    const record: StoredElementRecord = {
      tag,
      text: options?.text ?? "",
      classes: [],
      attributes: {},
      removed: false,
    };
    createdElements.push(record);
    const element = new MockElement(record);
    if (options?.cls) {
      element.addClass(options.cls);
    }
    if (options?.text) {
      element.text = options.text;
      createdElementTexts.push(options.text);
    }
    return element;
  }

  setText(value: string): void {
    this.text = value;
    if (this.record) {
      this.record.text = value;
    }
  }

  setAttribute(name: string, value: string): void {
    if (this.record) {
      this.record.attributes[name] = value;
    }
  }

  remove(): void {
    if (this.record) {
      this.record.removed = true;
    }
  }

  addEventListener(name: string, callback: () => void): void {
    const callbacks = this.eventListeners.get(name) ?? [];
    callbacks.push(callback);
    this.eventListeners.set(name, callbacks);
  }
}

export class MockButtonComponent {
  text = "";
  disabled = false;
  private clickCallback: (() => void | Promise<void>) | null = null;

  setButtonText(value: string): this {
    this.text = value;
    return this;
  }

  setCta(): this {
    return this;
  }

  setDestructive(): this {
    return this;
  }

  setDisabled(value: boolean): this {
    this.disabled = value;
    return this;
  }

  onClick(callback: () => void | Promise<void>): this {
    this.clickCallback = callback;
    return this;
  }

  async click(): Promise<void> {
    if (this.disabled) {
      return;
    }

    await this.clickCallback?.();
  }
}

export class MockTextComponent {
  private keydownCallback: ((event: MockKeyboardEvent) => void) | null = null;
  inputEl = {
    type: "text",
    value: "",
    autocomplete: "",
    readOnly: false,
    rows: 0,
    classList: {
      add(_value: string): void {},
    },
    focus(): void {},
    select(): void {},
    addEventListener: (name: string, callback: (event: MockKeyboardEvent) => void): void => {
      if (name === "keydown") {
        this.keydownCallback = callback;
      }
    },
  };
  value = "";
  placeholder = "";
  disabled = false;
  private changeCallback: ((value: string) => void | Promise<void>) | null = null;

  setPlaceholder(value: string): this {
    this.placeholder = value;
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    this.inputEl.value = value;
    return this;
  }

  setDisabled(value: boolean): this {
    this.disabled = value;
    return this;
  }

  onChange(callback: (value: string) => void | Promise<void>): this {
    this.changeCallback = callback;
    return this;
  }

  async change(value: string): Promise<void> {
    this.value = value;
    await this.changeCallback?.(value);
  }

  async pressKey(key: string, isComposing = false): Promise<void> {
    if (this.disabled) {
      return;
    }

    this.keydownCallback?.({
      key,
      isComposing,
      preventDefault(): void {},
    });
    await Promise.resolve();
  }
}

interface MockKeyboardEvent {
  key: string;
  isComposing: boolean;
  preventDefault(): void;
}

class MockTextAreaComponent extends MockTextComponent {}

export class MockToggleComponent {
  value = false;
  disabled = false;
  private changeCallback: ((value: boolean) => void | Promise<void>) | null = null;

  setValue(value: boolean): this {
    this.value = value;
    return this;
  }

  setDisabled(value: boolean): this {
    this.disabled = value;
    return this;
  }

  onChange(callback: (value: boolean) => void | Promise<void>): this {
    this.changeCallback = callback;
    return this;
  }

  async change(value: boolean): Promise<void> {
    if (this.disabled) {
      return;
    }

    this.value = value;
    await this.changeCallback?.(value);
  }
}

export class MockProgressBarComponent {
  value = 0;

  setValue(value: number): this {
    this.value = value;
    return this;
  }
}

export class MockDropdownComponent {
  options = new Map<string, string>();
  value = "";
  private changeCallback: ((value: string) => void | Promise<void>) | null = null;

  addOption(value: string, display: string): this {
    this.options.set(value, display);
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  onChange(callback: (value: string) => void | Promise<void>): this {
    this.changeCallback = callback;
    return this;
  }

  async change(value: string): Promise<void> {
    this.value = value;
    await this.changeCallback?.(value);
  }
}

export class MockExtraButtonComponent {
  disabled = false;
  icon = "";
  tooltip = "";
  extraSettingsEl = {
    classes: [] as string[],
    addClass: (value: string): void => {
      this.extraSettingsEl.classes.push(value);
    },
  };

  setDisabled(value: boolean): this {
    this.disabled = value;
    return this;
  }

  setIcon(value: string): this {
    this.icon = value;
    return this;
  }

  setTooltip(value: string): this {
    this.tooltip = value;
    return this;
  }
}

export class App {
  private readonly secrets = new Map<string, string>();
  private readonly localStorage = new Map<string, unknown>();

  secretStorage = {
    getSecret: (key: string): string | undefined => this.secrets.get(key),
    setSecret: (key: string, value: string): void => {
      if (!/^[a-z0-9-]+$/.test(key)) {
        throw new Error("Invalid secret ID");
      }

      this.secrets.set(key, value);
    },
  };

  loadLocalStorage(key: string): unknown {
    return this.localStorage.get(key) ?? null;
  }

  saveLocalStorage(key: string, data: unknown): void {
    if (data === null) {
      this.localStorage.delete(key);
      return;
    }

    this.localStorage.set(key, data);
  }
}

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: false,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
};

export class TAbstractFile {
  constructor(public path: string) {}
}

export class TFile extends TAbstractFile {}

export class TFolder extends TAbstractFile {}

export class Plugin {
  app = new App();
  manifest = {
    version: "0.0.1",
  };

  async loadData(): Promise<unknown> {
    return null;
  }

  async saveData(_value: unknown): Promise<void> {}

  register(_callback: () => unknown): void {}

  registerObsidianProtocolHandler(
    _action: string,
    _handler: (params: Record<string, string>) => unknown,
  ): void {}

  registerEvent(ref: unknown): unknown {
    return ref;
  }

  registerInterval(id: number): number {
    return id;
  }

  registerEditorExtension(_extension: unknown): void {}
}

export const editorInfoField = {};

export class Modal {
  containerEl = new MockElement();
  contentEl = new MockElement();

  constructor(public app: unknown) {}

  open(): void {
    this.onOpen();
  }

  close(): void {
    this.onClose();
  }

  onOpen(): void {}

  onClose(): void {}
}

export class Component {
  load(): void {}

  unload(): void {}
}

export class MarkdownRenderer {
  static async render(
    app: unknown,
    markdown: string,
    _el: unknown,
    sourcePath: string,
    component: unknown,
  ): Promise<void> {
    markdownRenderCalls.push({
      app,
      markdown,
      sourcePath,
      component,
    });
  }
}

export class PluginSettingTab {
  containerEl = new MockElement();
  settingItems: unknown[] = [];

  constructor(public app: unknown, public plugin: unknown) {}

  getSettingDefinitions(): unknown[] {
    return [];
  }

  getControlValue(_key: string): unknown {
    return undefined;
  }

  setControlValue(_key: string, _value: unknown): void {}

  update(): void {}

  refreshDomState(): void {}

  hide(): void {}
}

export class WorkspaceLeaf {}

export class ItemView {
  contentEl = new MockElement();

  constructor(public leaf: WorkspaceLeaf) {}
}

export class MockSettingElement extends MockElement {
  classes: string[] = [];
  detached = false;

  override addClass(value: string): void {
    if (!this.classes.includes(value)) {
      this.classes.push(value);
    }
  }

  removeClass(value: string): void {
    // Mutate in place: getSettingClasses tracks this array by reference.
    this.classes.splice(0, this.classes.length, ...this.classes.filter(
      (className) => className !== value,
    ));
  }

  toggleClass(value: string, enabled: boolean): void {
    if (enabled) {
      this.addClass(value);
      return;
    }

    this.removeClass(value);
  }

  get className(): string {
    return this.classes.join(" ");
  }

  set className(value: string) {
    this.classes.splice(0, this.classes.length, ...value.split(" ").filter(Boolean));
  }

  override remove(): void {
    this.detached = true;
  }
}

export class Setting {
  settingEl = new MockSettingElement();
  nameEl = new MockElement();
  descEl = new MockElement();
  controlEl = new MockElement();

  constructor(_containerEl: unknown) {
    settingClasses.push(this.settingEl.classes);
  }

  private nameIndex: number | null = null;
  private descIndex: number | null = null;

  // A row shows a single name/description, so repeated calls replace the
  // recorded value instead of appending a phantom row.
  setName(value: string): this {
    if (this.nameIndex === null) {
      this.nameIndex = settingNames.length;
      settingNames.push(value);
    } else {
      settingNames[this.nameIndex] = value;
    }
    this.nameEl.setText(value);
    return this;
  }

  setDesc(value: string): this {
    if (this.descIndex === null) {
      this.descIndex = settingDescriptions.length;
      settingDescriptions.push(value);
    } else {
      settingDescriptions[this.descIndex] = value;
    }
    this.descEl.setText(value);
    return this;
  }

  setHeading(): this {
    return this;
  }

  addButton(callback: (button: MockButtonComponent) => void): this {
    const button = new MockButtonComponent();
    buttonComponents.push(button);
    callback(button);
    return this;
  }

  addExtraButton(callback: (button: MockExtraButtonComponent) => void): this {
    const button = new MockExtraButtonComponent();
    extraButtonComponents.push(button);
    callback(button);
    return this;
  }

  addText(callback: (text: MockTextComponent) => void): this {
    const text = new MockTextComponent();
    textComponents.push(text);
    callback(text);
    return this;
  }

  addTextArea(callback: (text: MockTextAreaComponent) => void): this {
    const text = new MockTextAreaComponent();
    textComponents.push(text);
    callback(text);
    return this;
  }

  addToggle(callback: (toggle: MockToggleComponent) => void): this {
    const toggle = new MockToggleComponent();
    toggleComponents.push(toggle);
    callback(toggle);
    return this;
  }

  addDropdown(callback: (dropdown: MockDropdownComponent) => void): this {
    const dropdown = new MockDropdownComponent();
    dropdownComponents.push(dropdown);
    callback(dropdown);
    return this;
  }

  addProgressBar(callback: (progressBar: MockProgressBarComponent) => void): this {
    const progressBar = new MockProgressBarComponent();
    progressBarComponents.push(progressBar);
    callback(progressBar);
    return this;
  }
}

export class Notice {
  constructor(message: string, timeout?: number) {
    notices.push({ message, timeout });
  }
}

export function setIcon(
  parent: { setAttribute(name: string, value: string): void },
  iconId: string,
): void {
  parent.setAttribute("data-icon", iconId);
}

export function setTooltip(
  parent: { setAttribute(name: string, value: string): void },
  tooltip: string,
  options?: { delay?: number; placement?: string },
): void {
  parent.setAttribute("data-tooltip", tooltip);
  if (options?.delay !== undefined) {
    parent.setAttribute("data-tooltip-delay", String(options.delay));
  }
  if (options?.placement) {
    parent.setAttribute("data-tooltip-placement", options.placement);
  }
}

export function setRequestUrlMock(mock: RequestUrlMock): void {
  requestUrlMock = mock;
}

export function getLanguage(): string {
  return language;
}

export function setLanguage(value: string): void {
  language = value;
}

export function getButtonComponents(): MockButtonComponent[] {
  return [...buttonComponents];
}

export function getTextComponents(): MockTextComponent[] {
  return [...textComponents];
}

export function getToggleComponents(): MockToggleComponent[] {
  return [...toggleComponents];
}

export function getDropdownComponents(): MockDropdownComponent[] {
  return [...dropdownComponents];
}

export function getProgressBarComponents(): MockProgressBarComponent[] {
  return [...progressBarComponents];
}

export function getExtraButtonComponents(): MockExtraButtonComponent[] {
  return [...extraButtonComponents];
}

export function getCreatedElementTexts(): string[] {
  return [...createdElementTexts];
}

export function getCreatedElements(): CreatedElementRecord[] {
  return createdElements
    .filter((element) => !element.removed)
    .map((element) => ({
      tag: element.tag,
      text: element.text,
      classes: [...element.classes],
      attributes: { ...element.attributes },
    }));
}

export function getMarkdownRenderCalls(): MarkdownRenderCall[] {
  return [...markdownRenderCalls];
}

export function getSettingNames(): string[] {
  return [...settingNames];
}

export function getSettingDescriptions(): string[] {
  return [...settingDescriptions];
}

export function getSettingClasses(): string[][] {
  return settingClasses.map((classes) => [...classes]);
}

export function getNotices(): Array<{ message: string; timeout?: number }> {
  return notices.map((notice) => ({ ...notice }));
}

export function resetObsidianMocks(): void {
  requestUrlMock = null;
  language = "en";
  buttonComponents.length = 0;
  textComponents.length = 0;
  toggleComponents.length = 0;
  dropdownComponents.length = 0;
  progressBarComponents.length = 0;
  extraButtonComponents.length = 0;
  createdElementTexts.length = 0;
  createdElements.length = 0;
  markdownRenderCalls.length = 0;
  settingNames.length = 0;
  settingDescriptions.length = 0;
  settingClasses.length = 0;
  notices.length = 0;
}

export async function requestUrl(input: unknown): Promise<unknown> {
  if (!requestUrlMock) {
    throw new Error("requestUrl mock is not configured");
  }

  return await requestUrlMock(input);
}
