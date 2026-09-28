import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

// Execute the actual inline page script: Astro's build does not check its JS.
const page = await readFile(new URL("../src/components/BillingSettingsPage.astro", import.meta.url), "utf8");
const script = page.match(/<script\s+define:vars=[\s\S]*?>\s*([\s\S]*?)<\/script>/)[1];
const starter = {
  planId: "starter", active: true, status: "active", billingInterval: "monthly",
  canManageBilling: true, cancelAtPeriodEnd: false, periodEnd: null,
  availablePlusIntervals: ["monthly", "annual"],
};

class Element {
  children = [];
  listeners = {};
  disabled = false;
  textContent = "";
  value = "";
  constructor(tagName = "div") {
    this.tagName = tagName;
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    };
  }
  get options() { return this.children; }
  append(child) {
    this.children.push(child);
    if (this.tagName === "select" && !this.value) this.value = child.value;
  }
  replaceChildren() { this.children = []; }
  addEventListener(event, listener) { this.listeners[event] = listener; }
  querySelectorAll(tagName) {
    return this.children.flatMap(child => [
      ...(child.tagName === tagName ? [child] : []), ...child.querySelectorAll(tagName),
    ]);
  }
  click() { if (!this.disabled) return this.listeners.click?.(); }
}
class Button extends Element {
  constructor() { super("button"); }
}

async function setup(status = starter, { mutate, confirm = true } = {}) {
  const elements = new Map();
  for (const [, id] of page.matchAll(/id="([^"]+)"/g)) {
    elements.set(id, id.endsWith("-button") ? new Button() : new Element(id === "billing-organization" ? "select" : "div"));
  }
  const get = id => elements.get(id);
  get("upgrade-link").href = "https://synch.example/pricing";
  for (const id of ["manage-button", "switch-interval-button", "plus-checkout"]) get("billing-content").append(get(id));
  const writes = [], confirmations = [], redirects = [];
  const location = {
    href: "https://synch.example/billing?organizationId=org-1",
    origin: "https://synch.example", search: "?organizationId=org-1",
    assign: url => redirects.push(url),
  };
  const context = vm.createContext({
    URL, URLSearchParams, Intl, HTMLButtonElement: Button,
    apiUrl: "https://api.example", signupUrl: "https://api.example/signup",
    locale: "en", returnPath: "/billing", location,
    plusPricing: { monthly: 9, annual: 90 }, monthLabel: "/ month", yearLabel: "/ year",
    plusOrganizationPrice: "Total for the organization · up to 3 members, including the owner",
    history: { replaceState() {} },
    labels: {
      starterPlan: "Sync Starter", freePlan: "Sync Free", monthly: "Monthly", annual: "Annual",
      switchToAnnual: "Switch to annual billing", switchConfirm: "Switch to annual?", switching: "Switching...",
      upgradeToPlus: "Upgrade to Sync Plus", plusUpgradeConfirm: "Switch to Plus at {price}?",
      error: "Billing information could not be loaded.", billingEmailUnavailable: "Use a different billing email.",
    },
    window: { location, confirm: message => { confirmations.push(message); return confirm; } },
    document: {
      getElementById: get,
      querySelector: () => new Element("a"),
      createElement: tag => tag === "button" ? new Button() : new Element(tag),
    },
    fetch: async (url, options = {}) => {
      if (options.method === "POST") {
        const request = { path: new URL(url).pathname, body: JSON.parse(options.body) };
        writes.push(request);
        return mutate ? mutate(request) : response({
          ...status, ...request.body, availablePlusIntervals: undefined,
        });
      }
      return response(url.endsWith("/organizations")
        ? { organizations: [{ id: "org-1", name: "First" }, { id: "org-2", name: "Second" }] }
        : status);
    },
  });
  await vm.runInContext(script, context);
  assert.equal(get("billing-content").classList.contains("hidden"), false, "page should load");
  return { get, writes, confirmations, redirects, plusButtons: () => get("plus-checkout").children };
}
function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => JSON.parse(JSON.stringify(body)) };
}

test("a successful annual change renders the new interval instead of an error", async () => {
  const { get, writes } = await setup();
  await get("switch-interval-button").click();
  assert.deepEqual(writes, [{ path: "/v1/billing/change", body: { organizationId: "org-1", planId: "starter", billingInterval: "annual" } }]);
  assert.equal(get("billing-badge").textContent, "Annual");
  assert.equal(get("billing-error").classList.contains("hidden"), true);
  assert.equal(get("switch-interval-button").classList.contains("hidden"), true);
});

for (const interval of ["monthly", "annual"]) {
  test(`monthly Starter can upgrade its existing subscription to ${interval} Plus`, async () => {
    const { get, writes, confirmations, plusButtons } = await setup();
    assert.equal(plusButtons().length, 2);
    assert.equal(plusButtons()[0].textContent, "Upgrade to Sync Plus · $9 / month");
    assert.equal(plusButtons()[1].textContent, "Upgrade to Sync Plus · $90 / year");
    await plusButtons()[interval === "monthly" ? 0 : 1].click();
    assert.deepEqual(writes, [{ path: "/v1/billing/change", body: { organizationId: "org-1", planId: "plus", billingInterval: interval } }]);
    assert.equal(confirmations.length, 1);
    assert.equal(confirmations[0], `Switch to Plus at ${interval === "monthly" ? "$9 / month" : "$90 / year"}?\n\nTotal for the organization · up to 3 members, including the owner`);
    assert.equal(get("billing-plan").textContent, "Sync Plus");
    assert.equal(get("billing-error").classList.contains("hidden"), true);
    assert.equal(plusButtons().length, 0);
    // Preserve the status-only configuration when the change response omits it.
    assert.equal(get("switch-interval-button").classList.contains("hidden"), interval === "annual");
  });
}

test("annual Starter only offers annual Plus", async () => {
  const { writes, plusButtons } = await setup({ ...starter, billingInterval: "annual" });
  assert.equal(plusButtons().length, 1);
  assert.match(plusButtons()[0].textContent, /\$90 \/ year/);
  await plusButtons()[0].click();
  assert.equal(writes[0].body.billingInterval, "annual");
});

test("only configured, authorized, changeable Plus upgrades are offered", async () => {
  for (const overrides of [
    { canManageBilling: false }, { cancelAtPeriodEnd: true }, { status: "canceled" },
    { status: "past_due" }, { planId: "plus" }, { availablePlusIntervals: [] },
    { billingInterval: "annual", availablePlusIntervals: ["monthly"] },
  ]) {
    const { plusButtons } = await setup({ ...starter, ...overrides });
    assert.equal(plusButtons().length, 0, JSON.stringify(overrides));
  }
});

test("canceling the Plus confirmation does not change billing", async () => {
  const { writes, plusButtons } = await setup(starter, { confirm: false });
  await plusButtons()[0].click();
  assert.equal(writes.length, 0);
});

test("free accounts still use checkout for Plus", async () => {
  const url = "https://checkout.example/plus";
  const { writes, redirects, plusButtons } = await setup({ ...starter, active: false, planId: "free", billingInterval: null }, { mutate: () => response({ url }) });
  await plusButtons()[0].click();
  assert.equal(writes[0].path, "/v1/billing/checkout");
  assert.deepEqual(redirects, [url]);
});

test("checkout explains a billing email conflict without redirecting", async () => {
  const { get, redirects, plusButtons } = await setup(
    { ...starter, active: false, planId: "free", billingInterval: null },
    { mutate: () => response({ error: "billing_email_unavailable" }, 409) },
  );
  await plusButtons()[0].click();
  assert.equal(get("billing-error").classList.contains("hidden"), false);
  assert.equal(get("billing-error-message").textContent, "Use a different billing email.");
  assert.equal(get("billing-organization").disabled, false);
  assert.deepEqual(redirects, []);
});

test("a pending change prevents duplicate requests and restores controls after failure", async () => {
  let finish;
  const { get, writes, plusButtons } = await setup(starter, { mutate: () => new Promise(resolve => { finish = resolve; }) });
  const changing = plusButtons()[0].click();
  assert.equal(get("billing-organization").disabled, true);
  await get("switch-interval-button").click();
  await plusButtons()[1].click();
  assert.equal(writes.length, 1);
  finish(response({}, 500));
  await changing;
  assert.equal(get("billing-error").classList.contains("hidden"), false);
  assert.equal(get("billing-organization").disabled, false);
  assert.equal(get("switch-interval-button").disabled, false);
});

test("a late change response cannot overwrite another organization's status", async () => {
  let finish;
  const { get, writes } = await setup(starter, { mutate: () => new Promise(resolve => { finish = resolve; }) });
  const changing = get("switch-interval-button").click();
  const picker = get("billing-organization");
  picker.value = "org-2";
  picker.listeners.change();
  await new Promise(resolve => setImmediate(resolve));
  finish(response({ ...starter, billingInterval: "annual" }));
  await changing;
  assert.equal(writes[0].body.organizationId, "org-1");
  assert.equal(get("billing-badge").textContent, "Monthly");
  assert.equal(get("billing-error").classList.contains("hidden"), true);
});
