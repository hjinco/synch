import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const page = await readFile(new URL("../src/components/PricingPage.astro", import.meta.url), "utf8");
const script = page.match(/<script\s+define:vars=[\s\S]*?>\s*([\s\S]*?)<\/script>/)[1];

class Button {
  disabled = false;
  listeners = {};
  classList = { toggle() {} };
  constructor(billingInterval) { this.dataset = { billingInterval }; }
  addEventListener(event, listener) { this.listeners[event] = listener; }
  click() { return this.listeners.click(); }
}

function setup(fetchResponse) {
  const buttons = new Map(["starter", "plus"].map(plan => [`${plan}-checkout-button`, new Button()]));
  const intervals = [new Button("monthly"), new Button("annual")];
  const location = { origin: "https://synch.example", search: "?organizationId=org-1", href: "https://synch.example/pricing?organizationId=org-1" };
  const requests = [];
  const checkoutError = { textContent: "" };
  vm.runInNewContext(script, {
    URL, URLSearchParams, HTMLButtonElement: Button, location, window: { location },
    apiUrl: "https://api.example", signupUrl: "https://api.example/signup", billingUrl: "/billing",
    monthLabel: "/ month", yearLabel: "/ year", plusPricing: { monthly: 9, annual: 90 },
    billingEmailUnavailable: "Use a different billing email.",
    document: { getElementById: id => id === "checkout-error" ? checkoutError : buttons.get(id), querySelectorAll: () => intervals },
    fetch: async (url, options) => {
      requests.push({ url, ...options, body: JSON.parse(options.body) });
      return fetchResponse();
    },
  });
  return { buttons, intervals, location, requests, checkoutError };
}

for (const plan of ["starter", "plus"]) {
  for (const interval of ["monthly", "annual"]) {
    test(`${plan} opens ${interval} checkout for the selected organization`, async () => {
      const { buttons, intervals, location, requests } = setup(() => ({ ok: true, json: async () => ({ url: "https://checkout.example/session" }) }));
      intervals[interval === "annual" ? 1 : 0].click();
      await buttons.get(`${plan}-checkout-button`).click();
      assert.deepEqual(requests[0].body, { organizationId: "org-1", planId: plan, billingInterval: interval });
      assert.equal(requests[0].credentials, "include");
      assert.equal(requests[0].url, "https://api.example/v1/billing/checkout");
      assert.equal(location.href, "https://checkout.example/session");
    });
  }
}

test("pending checkout blocks both plans and failure allows retry", async () => {
  let finish;
  const { buttons, requests } = setup(() => new Promise(resolve => { finish = resolve; }));
  const pending = buttons.get("plus-checkout-button").click();
  assert.ok([...buttons.values()].every(button => button.disabled));
  await buttons.get("starter-checkout-button").click();
  assert.equal(requests.length, 1);
  finish({ ok: false, status: 500 });
  await pending;
  assert.ok([...buttons.values()].every(button => !button.disabled));
});

for (const status of [401, 409]) {
  test(`Plus preserves redirect handling for ${status}`, async () => {
    const { buttons, location } = setup(() => ({ ok: false, status, json: async () => ({ error: "subscription_already_active" }) }));
    const originalUrl = location.href;
    await buttons.get("plus-checkout-button").click();
    const target = new URL(location.href);
    assert.equal(target.pathname, status === 401 ? "/signup" : "/billing");
    assert.equal(target.searchParams.get(status === 401 ? "return_to" : "organizationId"), status === 401 ? originalUrl : "org-1");
  });
}

test("a billing email conflict stays on pricing and explains how to proceed", async () => {
  const { buttons, location, checkoutError } = setup(() => ({
    ok: false, status: 409, json: async () => ({ error: "billing_email_unavailable" }),
  }));
  const originalUrl = location.href;
  await buttons.get("plus-checkout-button").click();
  assert.equal(location.href, originalUrl);
  assert.equal(checkoutError.textContent, "Use a different billing email.");
  assert.ok([...buttons.values()].every(button => !button.disabled));
});
