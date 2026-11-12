// Turns whatever the browser's audio rate is (44.1k / 48k) into 16 kHz, 16-bit mono PCM,
// delivered in 100 ms chunks (1600 samples), which is what Gemini Live expects.
class Pcm16k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000; // input samples per output sample
    this.pos = 0;
    this.sum = 0;
    this.cnt = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0];
    if (!ch || !ch.length) return true;
    const len = ch[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < ch.length; c++) s += ch[c][i];
      this.sum += s / ch.length; // mono downmix
      this.cnt++;
      this.pos += 1;
      if (this.pos >= this.ratio) { // box average acts as a cheap low-pass before decimating
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.sum / this.cnt));
        this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        this.sum = 0; this.cnt = 0;
        if (this.n === this.out.length) {
          this.port.postMessage(this.out.buffer, [this.out.buffer]);
          this.out = new Int16Array(1600);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm16k', Pcm16k);
