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

// The few lines the "Improve with AI" pop-up shows. Sarvam has no way to read the balance through its API, so the person is
// pointed at "Credits Left" on the Sarvam dashboard instead.
export function improveLines({ transcriber, durationSec }) {
  const lines = ['Sarvam will listen to the saved recording again for a more accurate transcript.'];
  lines.push(/sarvam/i.test(transcriber || '')
    ? 'The live captions already used Sarvam, so this roughly doubles the cost for this meeting.'
    : 'This uses Sarvam credits.');
  const check = 'Pechu cannot see your Sarvam balance, so check “Credits Left” in your Sarvam dashboard first.';
  lines.push(durationSec > 0 ? `It needs ${priceLabel(durationSec, false)} in credits. ${check}` : check);
  return lines;
}
