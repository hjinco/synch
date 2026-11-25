import { delay, http } from "msw";
import { expect } from "storybook/test";
import type { Meta, StoryObj } from "./types";
import Component from "../src/components/PricingPage.astro";

const meta = {
  title: "Pages/Pricing",
  component: Component,
  args: { locale: "en" },
} satisfies Meta;
export default meta;
type Story = StoryObj;
export const Default: Story = {};

export const CheckoutLoading: Story = {
  parameters: {
    msw: {
      handlers: {
        checkout: [http.post("/v1/billing/checkout", () => delay("infinite"))],
      },
    },
  },
  async play({ canvasElement, userEvent }) {
    const button = canvasElement.querySelector("#plus-checkout-button");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing Plus checkout button");
    await userEvent.click(button);
    await expect(button).toHaveAttribute("aria-busy", "true");
  },
};
