// Every note of a MusicXML score as the alignment server sees it, for building the on-device
// alignment reference (practice/onDevice). The server loads a score with partitura the way
// matchmaker does -- load_musicxml(ignore_invisible_objects=True), unfold_part_maximal,
// merge_parts, note_array() -- and takes the tempo from get_tempo_from_score. This reproduces
// what those return, checked against partitura on every score the server has cached plus
// synthetic edge cases (`npm run deviceAlignTest`, from server/export_score_note_fixtures.py):
//
// - All parts, all voices, chord notes; ties merged into one note; grace notes kept with zero
//   length at the next note's onset; rests skipped; notes marked print-object="no" dropped and
//   take up no time.
// - Repeats unfolded "maximally": every repeated section played twice (a `times` attribute is
//   ignored, as partitura does), voltas followed. One deliberate difference: partitura's unfolding
//   deep-copies the score and fails past ~850 notes, after which matchmaker silently uses the
//   score as written; here repeats are always unfolded. The two only differ on long scores that
//   contain repeats.
// - Positions in quarter notes. A first bar shorter than its time signature (a pickup, or an
//   OMR-short first bar) shifts everything so the second bar starts at its length: the pickup
//   gets negative positions, as partitura's quarter_map does.
// - Tempo: the first <sound tempo> in score time, else the first in the document, else a tempo
//   word ("Andante" ...) in the first part converted to quarter-note BPM, else 120.
//
// Takes a parsed Document so it runs on the score engine's DOMParser (and xmldom in Node tests).

import type { MeterSegment, ReferenceNote } from "../practice/onDevice/referenceAudio";

export interface ScoreNotes {
  notes: ReferenceNote[];
  tempo: number;
  meter: MeterSegment[]; // time signatures of the first part, by position
  quarterOrigin: number; // position of the score's start (negative with a pickup)
  totalQuarters: number; // position of the score's end
}

const STEP_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// matchmaker.utils.misc.TEMPO_MARKING_TO_BPM, scanned in this order with a word boundary after the
// marking, as matchmaker does (so "allegretto" never matches "allegro").
const TEMPO_WORDS: [string, number][] = [
  ["larghissimo", 24], ["grave", 30], ["largo", 40], ["larghetto", 50], ["lento", 60], ["adagio", 60],
  ["adagietto", 70], ["andante", 80], ["andantino", 90], ["moderato", 110], ["allegretto", 120],
  ["allegro", 130], ["vivace", 150], ["vivacissimo", 170], ["presto", 180], ["prestissimo", 200]
];
const DEFAULT_TEMPO = 120;

function children(el: Element, tag?: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!tag || (n as Element).tagName === tag)) out.push(n as Element);
  }
  return out;
}
const child = (el: Element, tag: string): Element | undefined => children(el, tag)[0];
const text = (el: Element | undefined): string | null => (el && el.textContent !== null ? el.textContent.trim() : null);
const num = (el: Element | undefined): number | null => {
  const t = text(el);
  if (t === null || t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

interface MeasureInfo {
  el: Element;
  forward: boolean;
  backward: boolean;
  endings: Set<number> | null;
}

// partitura.score.unfold_part_maximal: repeated sections twice, voltas by pass number.
function playOrder(measures: MeasureInfo[]): number[] {
  const order: number[] = [];
  let pos = 0;
  let repeatStart = 0;
  let pass = 1;
  let jumped = false;
  let guard = 0;
  while (pos < measures.length && guard++ < measures.length * 8) {
    const m = measures[pos];
    if (m.forward && !jumped) {
      repeatStart = pos;
      pass = 1;
    }
    jumped = false;
    if (m.endings && !m.endings.has(pass)) {
      pos += 1;
      continue;
    }
    order.push(pos);
    if (m.backward) {
      if (pass === 1) {
        pass = 2;
        pos = repeatStart;
        jumped = true;
        continue;
      }
      pass = 1;
      repeatStart = pos + 1;
    }
    pos += 1;
  }
  return order;
}

function measureInfos(part: Element): MeasureInfo[] {
  const measures = children(part, "measure");
  const infos: MeasureInfo[] = measures.map((el) => ({ el, forward: false, backward: false, endings: null }));
  let openEnding: Set<number> | null = null;
  infos.forEach((info) => {
    let endingHere: Set<number> | null = openEnding;
    for (const barline of children(info.el, "barline")) {
      const repeat = child(barline, "repeat");
      if (repeat?.getAttribute("direction") === "forward") info.forward = true;
      if (repeat?.getAttribute("direction") === "backward") info.backward = true;
      const ending = child(barline, "ending");
      if (!ending) continue;
      const type = ending.getAttribute("type");
      if (type === "start") {
        const numbers = (ending.getAttribute("number") ?? "")
          .split(/[,\s]+/)
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > 0);
        endingHere = new Set(numbers);
        openEnding = endingHere;
      } else if (type === "stop" || type === "discontinue") {
        openEnding = null;
      }
    }
    info.endings = endingHere;
  });
  return infos;
}

function midiOf(pitch: Element): number | null {
  const step = text(child(pitch, "step"));
  const octave = num(child(pitch, "octave"));
  if (!step || !(step in STEP_SEMITONES) || octave === null) return null;
  const alter = num(child(pitch, "alter")) ?? 0;
  return (octave + 1) * 12 + STEP_SEMITONES[step] + Math.round(alter);
}

interface PartResult {
  notes: ReferenceNote[];
  firstMeasure: { start: number; end: number; nominal: number | null } | null;
  end: number;
  tempos: { time: number; bpm: number }[];
  meter: MeterSegment[];
}

function readPart(part: Element): PartResult {
  const infos = measureInfos(part);
  const order = playOrder(infos);
  const notes: ReferenceNote[] = [];
  const tempos: { time: number; bpm: number }[] = [];
  const meter: MeterSegment[] = [];
  // Open ties: "<voice>:<midi>" -> the note being extended.
  const ties = new Map<string, ReferenceNote>();
  let divisions = 1;
  let measureStart = 0; // quarters
  let firstMeasure: PartResult["firstMeasure"] = null;

  order.forEach((index, playIndex) => {
    const measure = infos[index].el;
    let position = measureStart;
    let maxTime = measureStart;
    let lastOnset = measureStart;
    let timeSigAtStart: { beats: number; beatType: number } | null = null;
    for (const el of children(measure)) {
      switch (el.tagName) {
        case "attributes": {
          const d = num(child(el, "divisions"));
          if (d) divisions = d;
          const time = child(el, "time");
          if (time) {
            const b = num(child(time, "beats"));
            const bt = num(child(time, "beat-type"));
            if (b && bt) {
              if (position === measureStart) timeSigAtStart = { beats: b, beatType: bt };
              const last = meter[meter.length - 1];
              if (!last || last.beatType !== bt || last.startQuarter !== position) meter.push({ startQuarter: position, beatType: bt });
            }
          }
          break;
        }
        case "backup": {
          position -= (num(child(el, "duration")) ?? 0) / divisions;
          if (position < measureStart) position = measureStart;
          maxTime = Math.max(maxTime, position);
          break;
        }
        case "forward": {
          position += (num(child(el, "duration")) ?? 0) / divisions;
          maxTime = Math.max(maxTime, position);
          break;
        }
        case "direction":
        case "sound": {
          const sound = el.tagName === "sound" ? el : child(el, "sound");
          const bpm = sound ? Number(sound.getAttribute("tempo")) : NaN;
          if (sound && sound.getAttribute("tempo") !== null && Number.isFinite(bpm)) tempos.push({ time: position, bpm });
          break;
        }
        case "note": {
          if (el.getAttribute("print-object") === "no") break;
          const isGrace = !!child(el, "grace");
          const isChord = !!child(el, "chord");
          const duration = isGrace ? 0 : (num(child(el, "duration")) ?? 0) / divisions;
          const onset = isChord ? lastOnset : position;
          if (!isChord && !isGrace) {
            lastOnset = position;
            position += duration;
            maxTime = Math.max(maxTime, position);
          } else if (!isChord) {
            lastOnset = position;
          }
          const pitchEl = child(el, "pitch");
          if (child(el, "rest") || !pitchEl) break;
          const midi = midiOf(pitchEl);
          if (midi === null) break;
          const voice = text(child(el, "voice")) ?? "1";
          const tieTypes = children(el, "tie").map((t) => t.getAttribute("type"));
          const key = `${voice}:${midi}`;
          const open = ties.get(key);
          if (tieTypes.includes("stop") && open) {
            open.durationQuarter = onset + duration - open.onsetQuarter;
            if (!tieTypes.includes("start")) ties.delete(key);
            break;
          }
          const note: ReferenceNote = { pitch: midi, onsetQuarter: onset, durationQuarter: duration };
          notes.push(note);
          if (tieTypes.includes("start")) ties.set(key, note);
          break;
        }
        default:
          break;
      }
    }
    if (playIndex === 0) {
      const ts = timeSigAtStart as { beats: number; beatType: number } | null;
      firstMeasure = { start: measureStart, end: maxTime, nominal: ts ? (ts.beats * 4) / ts.beatType : null };
    }
    measureStart = maxTime;
  });
  return { notes, firstMeasure, end: measureStart, tempos, meter };
}

// matchmaker.utils.misc.extract_tempo_marking_from_musicxml: the first tempo word at the start
// of a <words> direction in the first part, as quarter-note BPM for the meter in force there.
function tempoFromWords(doc: Document): number | null {
  const part = doc.getElementsByTagName("part")[0];
  if (!part) return null;
  let beats = 4;
  let beatType = 4;
  for (const measure of children(part, "measure")) {
    for (const time of Array.from(measure.getElementsByTagName("time"))) {
      const b = num(child(time, "beats"));
      const bt = num(child(time, "beat-type"));
      if (b) beats = b;
      if (bt) beatType = bt;
    }
    for (const words of Array.from(measure.getElementsByTagName("words"))) {
      const t = (words.textContent ?? "").toLowerCase().trim();
      for (const [marking, bpm] of TEMPO_WORDS) {
        if (new RegExp(`^${marking}\\b`).test(t)) {
          const compound = beats >= 6 && beats % 3 === 0;
          return compound ? bpm / 1.5 : bpm * (4 / beatType);
        }
      }
    }
  }
  return null;
}

export function scoreNotes(doc: Document): ScoreNotes {
  const parts = Array.from(doc.getElementsByTagName("part"));
  const results = parts.map(readPart);
  const notes = results.flatMap((r) => r.notes);
  // Stable sort by onset, like partitura's mergesort over the merged part's notes.
  const sorted = notes.map((n, i) => ({ n, i })).sort((a, b) => a.n.onsetQuarter - b.n.onsetQuarter || a.i - b.i).map((x) => x.n);

  // Pickup: a first bar shorter than its time signature moves the origin back by its length.
  let shift = 0;
  const first = results[0]?.firstMeasure;
  if (first && first.nominal !== null) {
    const actual = first.end - first.start;
    if (actual < first.nominal) shift = actual;
  }
  for (const n of sorted) n.onsetQuarter -= shift;
  const end = Math.max(0, ...results.map((r) => r.end));

  const timed = results.flatMap((r) => r.tempos).sort((a, b) => a.time - b.time);
  let tempo: number | null = timed.length ? timed[0].bpm : null;
  if (tempo === null) {
    const sound = Array.from(doc.getElementsByTagName("sound")).find((s) => s.getAttribute("tempo") !== null);
    const v = sound ? Number(sound.getAttribute("tempo")) : NaN;
    if (Number.isFinite(v)) tempo = v;
  }
  if (tempo === null) tempo = tempoFromWords(doc);

  const meter = (results[0]?.meter ?? []).map((m) => ({ startQuarter: m.startQuarter - shift, beatType: m.beatType }));
  return { notes: sorted, tempo: tempo ?? DEFAULT_TEMPO, meter, quarterOrigin: -shift, totalQuarters: end - shift };
}
