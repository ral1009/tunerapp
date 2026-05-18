const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, LevelFormat, BorderStyle, Table, TableRow, TableCell, WidthType, ShadingType
} = require('docx');
const fs = require('fs');

const bullet = (text, bold) => new Paragraph({
  numbering: { reference: "bullets", level: 0 },
  children: [new TextRun({ text, bold: bold || false, font: "Arial", size: 22 })]
});

const sub = (text) => new Paragraph({
  numbering: { reference: "subbullets", level: 0 },
  children: [new TextRun({ text, font: "Arial", size: 22 })]
});

const p = (text, opts) => new Paragraph({
  spacing: { after: 120 },
  children: [new TextRun({ text, font: "Arial", size: 22, ...(opts||{}) })]
});

const space = () => new Paragraph({ children: [new TextRun("")] });

const h1 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 320, after: 160 },
  children: [new TextRun({ text, font: "Arial", size: 32, bold: true, color: "534AB7" })]
});

const h2 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 240, after: 120 },
  children: [new TextRun({ text, font: "Arial", size: 26, bold: true, color: "1D9E75" })]
});

const h3 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_3,
  spacing: { before: 180, after: 80 },
  children: [new TextRun({ text, font: "Arial", size: 24, bold: true })]
});

const codeBlock = (lines) => lines.map(line => new Paragraph({
  spacing: { after: 0 },
  shading: { type: ShadingType.CLEAR, fill: "F0EFF8" },
  children: [new TextRun({ text: line, font: "Courier New", size: 18, color: "26215C" })]
}));

const doc = new Document({
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }]
      },
      {
        reference: "subbullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "\u25E6", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 1080, hanging: 360 } } } }]
      },
      {
        reference: "numbered",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } }]
      }
    ]
  },
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 320, after: 160 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, font: "Arial" },
        paragraph: { spacing: { before: 180, after: 80 }, outlineLevel: 2 } },
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      }
    },
    children: [

      // ── TITLE ──
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 80 },
        children: [new TextRun({ text: "Sheet Music Tuner App", font: "Arial", size: 52, bold: true, color: "534AB7" })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 40 },
        children: [new TextRun({ text: "Full Project Context & Continuation Guide", font: "Arial", size: 28, color: "6b6b9a", italics: true })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 480 },
        children: [new TextRun({ text: "Generated May 2026 — paste this doc into a new chat to continue", font: "Arial", size: 20, color: "888780" })]
      }),

      // ── 1. ORIGINAL VISION ──
      h1("1. Original Vision & Problem Statement"),
      p("The goal is to build a violin practice app that solves three specific problems:"),
      space(),
      bullet("Inconvenience of juggling two tools: musicians currently have to switch between a tuner app and sheet music, forcing them to look at two places at once."),
      bullet("Poor tuner accuracy: current violin tuner apps struggle with fast notes and are confused by background noise and harmonics."),
      bullet("Ear training dependency: tuner apps cause bad habits — players become overreliant and stop using their ears."),
      space(),
      p("The core insight is: if the app already knows what note should be playing (from the sheet music), it only needs to confirm whether the detected pitch is close to that specific target — not identify the note from scratch. This context-anchored approach is fundamentally more accurate than blind pitch detection."),

      space(),
      h1("2. Full Feature Plan"),

      h2("Core (MVP)"),
      bullet("Upload sheet music (PDF or MusicXML)"),
      bullet("App parses the notes — using OMR (optical music recognition) for PDFs, or MusicXML data directly"),
      bullet("Play through the piece while the app listens and tracks intonation in real time"),
      bullet("Notes highlighted green (in tune) or red (out of tune) directly on the staff"),
      bullet("Context-anchored pitch detection: only looks for the expected pitch, not the whole spectrum"),

      space(),
      h2("Ear Training Mode"),
      bullet("Tuner display hidden during practice — no visual feedback while playing"),
      bullet("When a note is out of tune, app plays a drone of the correct pitch so the player adjusts by ear"),
      bullet("Results shown only after the session ends"),

      space(),
      h2("Additional Features (post-MVP)"),
      bullet("Markup tools: pen and highlighter annotations on the sheet music"),
      bullet("Fingering assignments: click a note, assign a fingering number, shown on the score"),
      bullet("Practice Review: after playing through, identifies which bars need the most work"),
      bullet("Spot Practice: select a bar range, loop it, track accuracy each repeat"),
      bullet("Practice Streak: daily practice tracking to encourage consistency"),

      space(),
      h1("3. Prototype Journey — What We Built & What Broke"),

      h2("v1 — Basic autocorrelation"),
      p("First working prototype. Used standard autocorrelation pitch detection via Web Audio API AnalyserNode."),
      bullet("Result: worked fine for voice, completely failed for violin"),
      bullet("Root cause: violin has strong harmonics that dominate over the fundamental frequency. Autocorrelation latched onto a harmonic instead of the true note."),

      space(),
      h2("v2 — Harmonic Product Spectrum attempt"),
      p("Tried replacing autocorrelation with HPS (Harmonic Product Spectrum), which multiplies harmonics together to amplify the true fundamental."),
      bullet("Result: neither voice nor violin detected — total failure"),
      bullet("Root cause: the HPS implementation ran a brute-force FFT in JavaScript on every animation frame, which was far too slow. It blocked the audio thread entirely."),

      space(),
      h2("v3 — Back to autocorrelation + octave correction"),
      p("Reverted to the working autocorrelation from v1, but added two targeted fixes:"),
      bullet("Octave correction: checks +/- 2 octaves from the raw detected pitch and picks whichever is closest to the target note"),
      bullet("Disabled browser audio processing (echoCancellation, noiseSuppression, autoGainControl) which was mangling instrument audio"),
      bullet("Added debug line showing raw hz, corrected hz, and RMS level"),
      bullet("Result: detected voice again, and sometimes detected violin — but severe spasming between +300 and -300 cents, flickering rapidly"),
      bullet("Also required mic input at 100% volume to get any signal"),

      space(),
      h2("v4 — Median filtering + lower RMS threshold (WORKING)"),
      p("The final working version. Two key fixes resolved all remaining issues:"),
      space(),
      h3("Fix 1: Median window filtering"),
      p("Instead of using a single smoothed value, v4 collects the last 9 raw pitch readings and takes the median. Because the violin was producing occasional harmonic spikes (e.g. jumping to 2x the true frequency for one frame), a rolling average would still be dragged off centre. The median is immune to outliers — as long as fewer than half the readings are wrong, the output is stable."),
      space(),
      ...codeBlock([
        "const MEDIAN_WIN = 9;",
        "const recentHz = [];",
        "",
        "if (raw > 0) {",
        "  recentHz.push(raw);",
        "  if (recentHz.length > MEDIAN_WIN) recentHz.shift();",
        "} else {",
        "  if (recentHz.length > 0) recentHz.shift();",
        "}",
        "",
        "function median(arr) {",
        "  const s = [...arr].sort((a, b) => a - b);",
        "  const m = Math.floor(s.length / 2);",
        "  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;",
        "}",
        "",
        "const med = recentHz.length >= 3 ? median(recentHz) : -1;"
      ]),
      space(),
      h3("Fix 2: Lower RMS silence threshold"),
      p("The silence gate (minimum signal level before detection runs) was 0.006. Lowered to 0.003, which halved the input volume required. This is why 100% mic volume was previously needed."),
      space(),
      h3("Other details in v4"),
      bullet("Hz log: every 3rd frame is logged to an array with timestamp, raw hz, corrected hz, target note, cents, and RMS"),
      bullet("Download Hz log button: exports a CSV file for debugging"),
      bullet("Hold bar: progress indicator showing how long the note has been held in tune (600ms required to advance)"),
      bullet("RMS shown in debug line for easy diagnosis"),

      space(),
      h1("4. Technical Architecture of the Working Prototype"),

      h2("Audio pipeline"),
      ...codeBlock([
        "// Microphone setup (browser audio processing disabled)",
        "navigator.mediaDevices.getUserMedia({",
        "  audio: {",
        "    echoCancellation: false,",
        "    noiseSuppression: false,",
        "    autoGainControl: false",
        "  }",
        "})",
        "",
        "// Web Audio API",
        "audioCtx = new AudioContext({ sampleRate: 44100 });",
        "analyser = audioCtx.createAnalyser();",
        "analyser.fftSize = 2048;",
        "analyser.smoothingTimeConstant = 0;  // no built-in smoothing",
        "analyser.getFloatTimeDomainData(rawBuf);  // raw waveform per frame"
      ]),

      space(),
      h2("Pitch detection function"),
      p("Standard autocorrelation. Works by finding the lag at which the signal most resembles itself — this lag corresponds to the period (1/frequency) of the note."),
      ...codeBlock([
        "function detectRaw(buf, sampleRate) {",
        "  // 1. RMS silence gate",
        "  let rms = 0;",
        "  for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];",
        "  rms = Math.sqrt(rms / buf.length);",
        "  if (rms < 0.003) return -1;  // too quiet",
        "",
        "  // 2. Autocorrelation",
        "  const corr = new Float32Array(buf.length);",
        "  for (let lag = 0; lag < buf.length; lag++) {",
        "    let s = 0;",
        "    for (let i = 0; i < buf.length - lag; i++) s += buf[i] * buf[i+lag];",
        "    corr[lag] = s;",
        "  }",
        "",
        "  // 3. Find first dip (skip the zero-lag peak)",
        "  let d = 1;",
        "  while (d < buf.length-1 && corr[d] > corr[d+1]) d++;",
        "",
        "  // 4. Find highest peak after the dip (within violin frequency range)",
        "  const minLag = Math.floor(sampleRate / 2000);  // max 2000hz",
        "  const maxLag = Math.floor(sampleRate / 100);   // min 100hz",
        "  let maxVal = -1, bestLag = -1;",
        "  for (let i = Math.max(d, minLag); i < Math.min(buf.length-1, maxLag); i++) {",
        "    if (corr[i] > maxVal) { maxVal = corr[i]; bestLag = i; }",
        "  }",
        "",
        "  // 5. Confidence check",
        "  if (bestLag < 1 || maxVal / corr[0] < 0.35) return -1;",
        "",
        "  // 6. Parabolic interpolation for sub-sample accuracy",
        "  const y1 = corr[bestLag-1], y2 = corr[bestLag], y3 = corr[bestLag+1];",
        "  const refined = bestLag - (y3 - y1) / (2 * (2*y2 - y1 - y3));",
        "  return sampleRate / refined;",
        "}"
      ]),

      space(),
      h2("Octave correction"),
      p("After getting the median, the detected Hz is compared against the target note across +/- 2 octaves. The octave that minimises the cent error is used. This handles the common violin case where autocorrelation finds the 2nd harmonic (an octave up) instead of the fundamental."),
      ...codeBlock([
        "function closestOctave(hz, targetHz) {",
        "  let best = hz, bestDiff = Math.abs(hzToCents(hz, targetHz));",
        "  for (let o = -2; o <= 2; o++) {",
        "    const candidate = hz * Math.pow(2, o);",
        "    const diff = Math.abs(hzToCents(candidate, targetHz));",
        "    if (diff < bestDiff) { bestDiff = diff; best = candidate; }",
        "  }",
        "  return best;",
        "}"
      ]),

      space(),
      h2("Note advancement logic"),
      p("The app advances to the next note when the detected pitch stays within 35 cents of the target for 600ms continuously. The hold bar fills as a visual indicator. On advancement, the recent Hz buffer is cleared to prevent carry-over."),

      space(),
      h2("Melody encoding"),
      ...codeBlock([
        "const MELODY = [",
        "  { name: 'E',  oct: 5, midi: 88 },",
        "  { name: 'F#', oct: 5, midi: 90 },",
        "  { name: 'G#', oct: 5, midi: 92 },",
        "  { name: 'A',  oct: 5, midi: 93 },",
        "  { name: 'B',  oct: 5, midi: 95 },",
        "  { name: 'A',  oct: 5, midi: 93 },",
        "  { name: 'G#', oct: 5, midi: 92 },",
        "  { name: 'F#', oct: 5, midi: 90 },",
        "];",
        "",
        "// MIDI to Hz conversion",
        "function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }",
        "",
        "// Hz to cents offset from reference",
        "function hzToCents(hz, ref) { return 1200 * Math.log2(hz / ref); }"
      ]),

      space(),
      h1("5. Known Remaining Limitations"),
      bullet("Autocorrelation is still not ideal for violin — it works, but a proper MPM (McLeod Pitch Method) implementation via the 'pitchy' npm package would be more accurate. This requires moving to a real dev environment (Claude Code + Node.js)."),
      bullet("No real sheet music rendering — notes are displayed as labeled boxes, not an actual staff. VexFlow (a JS sheet music library) would add proper notation."),
      bullet("No sheet music upload or OMR — the melody is hardcoded. Real OMR requires a library like Audiveris, or MusicXML file support."),
      bullet("No page tracking / auto-scroll — in a real app, the playhead needs to advance through the score automatically."),
      bullet("Prototype only runs in this browser artifact — not a standalone app yet."),

      space(),
      h1("6. Next Steps & Roadmap"),

      h2("Phase 1 — Move to a real codebase"),
      p("Use Claude Code (terminal app) to scaffold a proper React project."),
      bullet("npm install pitchy — replace autocorrelation with MPM for much better violin accuracy"),
      bullet("npm install vexflow — render actual sheet music from note data"),
      bullet("Get the working v4 prototype logic running in a local React app"),

      space(),
      h2("Phase 2 — Sheet music input"),
      bullet("Support MusicXML file upload (exported from MuseScore, Sibelius, Finale)"),
      bullet("Parse MusicXML to extract note sequence, timing, and bar structure"),
      bullet("Display parsed score in VexFlow"),

      space(),
      h2("Phase 3 — Core tuner features"),
      bullet("Per-note accuracy coloring on the actual VexFlow staff (not just boxes)"),
      bullet("Playhead tracking through the score"),
      bullet("Practice Review screen: per-bar heatmap, worst notes highlighted"),
      bullet("Spot Practice: select bar range, loop with accuracy tracking"),

      space(),
      h2("Phase 4 — Ear training & polish"),
      bullet("Drone mode: play sine wave at correct pitch when out of tune"),
      bullet("Hidden tuner mode: no visual feedback during practice, results shown after"),
      bullet("Markup tools: pen/highlighter annotation on score"),
      bullet("Fingering labels: click note to assign finger number"),
      bullet("Practice streak / daily tracking"),

      space(),
      h2("Phase 5 — Platform & distribution"),
      bullet("Mobile app (React Native or Capacitor to wrap the web app)"),
      bullet("Teacher dashboard: assign pieces, review student accuracy data"),
      bullet("PDF sheet music upload + OMR processing (hardest piece — consider Audiveris or a cloud OMR API)"),

      space(),
      h1("7. Key Technical Decisions Already Made"),
      bullet("No browser audio processing (echoCancellation etc. OFF) — essential for instrument input"),
      bullet("Median filtering over smoothing — immune to harmonic spikes"),
      bullet("Octave correction as post-processing step — cheap and effective"),
      bullet("Context-anchored detection — only match against the expected note, not all notes"),
      bullet("MusicXML as primary sheet music format (not PDF OMR) for the first real version"),
      bullet("VexFlow for score rendering (open source, browser-native)"),
      bullet("pitchy (MPM algorithm) for pitch detection once in a real dev environment"),

      space(),
      h1("8. How to Continue This Project"),
      p("Paste this document into a new Claude chat and say:"),
      space(),
      new Paragraph({
        spacing: { after: 120 },
        shading: { type: ShadingType.CLEAR, fill: "EEEDFE" },
        children: [new TextRun({
          text: '"I\'m continuing my sheet music violin tuner app project. Here\'s the full context doc. I want to move to a real codebase using Claude Code — help me set up the React project with pitchy and VexFlow, starting from the working v4 pitch detection logic."',
          font: "Arial", size: 22, italics: true, color: "3C3489"
        })]
      }),
      space(),
      p("Claude will have full context of everything built, all the dead ends, and the exact code that works, and can pick up exactly where this conversation left off.", { color: "444441" }),

      space(),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 480 },
        children: [new TextRun({ text: "— end of context document —", font: "Arial", size: 18, color: "888780", italics: true })]
      }),
    ]
  }]
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync('/mnt/user-data/outputs/sheet_music_tuner_context.docx', buf);
  console.log('done');
});
