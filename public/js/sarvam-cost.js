// Sarvam's list prices in rupees per minute of audio, before tax (docs.sarvam.ai pricing page, November 2026).
// Shown next to the buttons that spend money, so the cost is known before pressing them.
export const PER_MINUTE = 0.49;
export const PER_MINUTE_SPEAKERS = 0.59; // speaker labels are billed higher

// "about ₹25" when the length of the recording is known, otherwise "₹0.49 a minute"
export function priceLabel(durationSec, speakers) {
  const rate = speakers ? PER_MINUTE_SPEAKERS : PER_MINUTE;
  if (!(durationSec > 0)) return `₹${rate.toFixed(2)} a minute`;
  return `about ₹${Math.max(1, Math.ceil((durationSec / 60) * rate))}`;
}
