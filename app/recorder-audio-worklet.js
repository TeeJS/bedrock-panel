'use strict';
// Preserve the old 4096-frame processing cadence and its partial-block stop behavior.
class RecorderPcm extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.echoGate = !!opts.echoGate;
    this.threshold = opts.threshold;
    this.size = opts.bufferSize || 4096;
    this.mic = new Float32Array(this.size);
    this.sys = new Float32Array(this.size);
    this.used = 0;
  }
  process(inputs) {
    const channels = inputs[0] || [];
    const mic = channels[0], sys = channels[1];
    const length = (mic || sys || new Float32Array(128)).length;
    for (let i = 0; i < length; i++) {
      this.mic[this.used] = mic ? mic[i] : 0;
      this.sys[this.used] = sys ? sys[i] : 0;
      if (++this.used === this.size) { this.emitBlock(); this.used = 0; }
    }
    return true;
  }
  emitBlock() {
    let micSum = 0, sysSum = 0;
    for (let i = 0; i < this.size; i++) { micSum += this.mic[i] * this.mic[i]; sysSum += this.sys[i] * this.sys[i]; }
    const micRms = Math.sqrt(micSum / this.size), systemRms = Math.sqrt(sysSum / this.size);
    const micGated = this.echoGate && systemRms > this.threshold;
    const pcm = new Int16Array(this.size * 2);
    for (let i = 0; i < this.size; i++) {
      const m = Math.max(-1, Math.min(1, micGated ? 0 : this.mic[i]));
      const s = Math.max(-1, Math.min(1, this.sys[i]));
      pcm[i * 2] = m < 0 ? m * 0x8000 : m * 0x7fff;
      pcm[i * 2 + 1] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage({ pcm: pcm.buffer, meta: { micRms, systemRms, micGated } }, [pcm.buffer]);
  }
}
registerProcessor('recorder-pcm', RecorderPcm);
