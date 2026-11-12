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

// Which meetings get the "Improve with AI" prompt: any with a saved recording and a transcript, once Sarvam is switched on.
// Not while a job is running, and not without a recording to listen to again.
export const canImprove = (m, sarvamOn) => !!(sarvamOn && m?.audio && m?.transcript?.trim() && (m.status === 'ready' || m.status === 'error'));

// A live meeting that Sarvam has not listened to yet: its transcript is still the live captions.
export const isLiveCaptions = (m) => m?.source === 'live' && !m?.transcriptLive;

// The few lines the "Improve with AI" pop-up shows. Sarvam has no way to read the balance through its API, so the person is
// pointed at "Credits Left" on the Sarvam dashboard instead.
export function improveLines({ transcriber, durationSec, fromLive = true }) {
  const lines = ['Sarvam will listen to the saved recording again for a more accurate transcript.'];
  const sarvam = /sarvam/i.test(transcriber || '');
  lines.push(fromLive && sarvam ? 'The live captions already used Sarvam, so this roughly doubles the cost for this meeting.'
    : sarvam ? 'Sarvam already transcribed this recording, so this costs about the same again.'
    : 'This uses Sarvam credits.');
  const check = 'Pechu cannot see your Sarvam balance, so check “Credits Left” in your Sarvam dashboard first.';
  lines.push(durationSec > 0 ? `It needs ${priceLabel(durationSec, false)} in credits. ${check}` : check);
  return lines;
}
