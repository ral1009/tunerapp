// A small live meter for the practice screen on a real phone. Every 2 s it prints one line to the
// Metro terminal: microphone chunks handled, time spent handling them, screen renders, and how late
// the JS thread is running (a 100 ms timer's worst overshoot). Added after a phone report of the
// readout, cursor and buttons all lagging, which a laptop -- even with the JIT off -- didn't show.

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

let chunks = 0;
let chunkMs = 0;
let renders = 0;
let worstLag = 0;
let samples = 0;
const sections: Record<string, number> = {};
let running = 0;

export function probeChunk<T>(fn: () => T, sampleCount: number): T {
  const t = now();
  try {
    return fn();
  } finally {
    chunks += 1;
    samples += sampleCount;
    chunkMs += now() - t;
  }
}

export function probeSection<T>(name: string, fn: () => T): T {
  const t = now();
  try {
    return fn();
  } finally {
    sections[name] = (sections[name] ?? 0) + now() - t;
  }
}

export function probeRender(): void {
  renders += 1;
}

// Starts the meter; returns a stop function. Only one runs at a time.
export function startProbe(): () => void {
  running += 1;
  if (running > 1) return () => void (running -= 1);
  let expected = now() + 100;
  const tick = setInterval(() => {
    const t = now();
    worstLag = Math.max(worstLag, t - expected);
    expected = t + 100;
  }, 100);
  const report = setInterval(() => {
    const parts = Object.entries(sections).map(([k, v]) => `${k} ${v.toFixed(0)}ms`).join(', ');
    console.log(
      `[perf] 2s: mic ${chunks} chunks (${(samples / 2000).toFixed(1)}k samples/s), handling ${chunkMs.toFixed(0)}ms` +
        `${parts ? ` [${parts}]` : ''}, renders ${renders}, JS thread late by up to ${worstLag.toFixed(0)}ms`,
    );
    chunks = 0;
    chunkMs = 0;
    renders = 0;
    worstLag = 0;
    samples = 0;
    for (const k of Object.keys(sections)) delete sections[k];
  }, 2000);
  return () => {
    running -= 1;
    clearInterval(tick);
    clearInterval(report);
  };
}
