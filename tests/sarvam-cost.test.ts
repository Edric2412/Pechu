import { expect, test } from "bun:test";
import { PER_MINUTE, PER_MINUTE_SPEAKERS, priceLabel } from "../public/js/sarvam-cost.js";

test("the rates are the published Sarvam prices", () => {
  expect(PER_MINUTE).toBe(0.49);
  expect(PER_MINUTE_SPEAKERS).toBe(0.59);
});

test("the price is rounded up to a whole rupee when the length is known", () => {
  expect(priceLabel(3000, false)).toBe("about ₹25"); // 50 min x 0.49 = 24.5
  expect(priceLabel(3000, true)).toBe("about ₹30"); // 50 min x 0.59 = 29.5
  expect(priceLabel(60, false)).toBe("about ₹1");
  expect(priceLabel(10, false)).toBe("about ₹1"); // never says "about ₹0"
});

test("without a length it shows the rate per minute", () => {
  expect(priceLabel(null, false)).toBe("₹0.49 a minute");
  expect(priceLabel(undefined, true)).toBe("₹0.59 a minute");
  expect(priceLabel(0, false)).toBe("₹0.49 a minute");
});
