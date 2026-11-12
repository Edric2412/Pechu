import { expect, test } from "bun:test";
import { PER_MINUTE, PER_MINUTE_SPEAKERS, improveLines, priceLabel } from "../public/js/sarvam-cost.js";

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

test("the Improve with AI pop-up says, briefly, that it roughly doubles the cost after live Sarvam captions", () => {
  const lines = improveLines({ transcriber: "Sarvam Saaras v4", durationSec: 3000 });
  expect(lines[0]).toContain("listen to the saved recording again");
  expect(lines.join(" ")).toContain("roughly doubles the cost");
  expect(lines.length).toBeLessThanOrEqual(3);
});

test("the pop-up names the credits needed and points to the dashboard, because Pechu cannot read the balance", () => {
  const text = improveLines({ transcriber: "Sarvam Saaras v4", durationSec: 3000 }).join(" ");
  expect(text).toContain("about ₹25");
  expect(text).toContain("Credits Left");
  expect(text).toContain("cannot see your Sarvam balance");
});

test("captions from another service do not claim a doubled cost, and an unknown length shows no amount", () => {
  const other = improveLines({ transcriber: "Gemini 3.5 Transcribe Live", durationSec: 600 }).join(" ");
  expect(other).not.toContain("doubles");
  expect(other).toContain("uses Sarvam credits");
  const unknown = improveLines({ transcriber: "Sarvam Saaras v4", durationSec: null }).join(" ");
  expect(unknown).not.toContain("about ₹");
  expect(unknown).toContain("Credits Left");
});
