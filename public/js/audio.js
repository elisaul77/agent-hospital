// Bell sound: a two-note strike synthesized with WebAudio (no asset files). Off by default. The AudioContext is
// created only when the user turns the sound on (a click, as browsers require) and never while it is off.
export function createBellSound({ AudioCtor = globalThis.AudioContext, log = (m) => console.error(m) } = {}) {
  let enabled = false;
  let ctx = null;

  function context() {
    if (ctx) return ctx;
    if (typeof AudioCtor !== 'function') {
      log('[hospital] WebAudio unavailable; bell sound stays off');
      enabled = false;
      return null;
    }
    ctx = new AudioCtor();
    return ctx;
  }

  return {
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = Boolean(on);
      if (enabled) context();
      return enabled;
    },
    /** @returns {boolean} true when a strike was scheduled */
    ring() {
      if (!enabled) return false;
      const c = context();
      if (!c) return false;
      strike(c, 659.25, 0);
      strike(c, 523.25, 0.35);
      return true;
    },
  };
}

function strike(c, freq, at) {
  const t0 = c.currentTime + at;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.25, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.2);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + 1.3);
}
