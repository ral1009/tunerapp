import argparse
import csv
import json
import os
from pathlib import Path

import pretty_midi
import requests
import soundfile as sf


# ==========================
# SETTINGS
# ==========================

# Vocal range limits, roughly C2-C7. Passed straight into Basic Pitch's own frequency
# search (not just used as a post-hoc filter) so it never even considers pitches outside
# a singer's plausible range in the first place.
MIN_PITCH = 36
MAX_PITCH = 96
MIN_FREQUENCY_HZ = pretty_midi.note_number_to_hz(MIN_PITCH)
MAX_FREQUENCY_HZ = pretty_midi.note_number_to_hz(MAX_PITCH)

# Basic Pitch's own onset/frame confidence gates and minimum note length. Basic Pitch's
# defaults (0.5 / 0.3 / 127.7ms) dropped real, quieter or shorter sung notes entirely
# (missing notes / dead air). Raising these back toward the defaults to fight false
# flourishes also silently dropped real notes in higher/faster passages (fast runs and
# belted high notes tend to be shorter). Kept permissive here instead -- catch everything,
# including real high/quiet notes -- and rely on remove_passing_blips()'s confidence check
# below to do the precision cleanup, since it can tell a real (loud) note from a spurious
# (quiet) one, which a blanket detection threshold can't.
ONSET_THRESHOLD = 0.4
FRAME_THRESHOLD = 0.25
MIN_NOTE_LENGTH_MS = 58.0

# Drop notes whose confidence (Basic Pitch's amplitude, carried through as MIDI velocity)
# is too low to trust as a real sung note rather than noise/breath/harmonic bleed.
MIN_VELOCITY = 8

# Consecutive fragments this close together, wobbling within this many semitones of each
# other, are basic-pitch mis-reading a single held note's vibrato/pitch jitter as a run of
# separate short notes (heard as fake trills/flourishes breaking up one sustained phrase).
# Collapsed into a single note spanning the whole stretch rather than kept as separate
# notes. A real melodic step almost always exceeds this pitch tolerance, so intentional
# fast passages are not affected.
VIBRATO_MERGE_GAP = 0.15
VIBRATO_PITCH_TOLERANCE = 1

# A short note sandwiched between two much longer notes that agree in pitch (an A-B-A
# pattern) *and* is quieter/less confident than both of them is almost always a brief
# spurious misread -- not a deliberate grace note/ornament/belted high note -- so it's
# dropped and the held note is stitched across the gap. The confidence check matters: a
# real emphasized note (e.g. a belted high note) is usually just as loud as its
# surroundings, not weaker, so requiring it to be the weakest of the three keeps genuine
# short/loud notes intact while still catching actual artifacts.
BLIP_MAX_DURATION = 0.18
BLIP_NEIGHBOR_PITCH_TOLERANCE = 1

# Final safety-net floor once everything else has run; Basic Pitch's own MIN_NOTE_LENGTH_MS
# already does the real work of this.
MIN_DURATION = 0.05

# GeneralUser GS: a well-established, freeware GM soundfont with a genuinely good acoustic
# piano patch (~30MB), mirrored on GitHub with a stable raw-file URL. Override with the
# VOCAL_PIPELINE_SOUNDFONT env var to point at a different .sf2 of your own.
DEFAULT_SOUNDFONT_URL = (
    "https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2"
)
SOUNDFONT_CACHE_DIR = Path.home() / ".cache" / "vocal-pipeline"
SOUNDFONT_CACHE_PATH = SOUNDFONT_CACHE_DIR / "GeneralUser-GS.sf2"


class NoNotesDetectedError(Exception):
    pass


# ==========================
# TRANSCRIPTION
# ==========================

def transcribe_to_midi(audio_path: Path) -> pretty_midi.PrettyMIDI:
    from basic_pitch.inference import predict

    print("Running Basic Pitch...")
    _, midi_data, _ = predict(
        str(audio_path),
        onset_threshold=ONSET_THRESHOLD,
        frame_threshold=FRAME_THRESHOLD,
        minimum_note_length=MIN_NOTE_LENGTH_MS,
        minimum_frequency=MIN_FREQUENCY_HZ,
        maximum_frequency=MAX_FREQUENCY_HZ,
        melodia_trick=True,
    )
    return midi_data


def merge_vibrato_fragments(notes: list[pretty_midi.Note]) -> list[pretty_midi.Note]:
    if not notes:
        return []

    groups: list[list[pretty_midi.Note]] = [[notes[0]]]
    group_min_pitch = [notes[0].pitch]
    group_max_pitch = [notes[0].pitch]

    for note in notes[1:]:
        gap = note.start - groups[-1][-1].end
        new_min = min(group_min_pitch[-1], note.pitch)
        new_max = max(group_max_pitch[-1], note.pitch)

        if gap < VIBRATO_MERGE_GAP and (new_max - new_min) <= VIBRATO_PITCH_TOLERANCE:
            groups[-1].append(note)
            group_min_pitch[-1] = new_min
            group_max_pitch[-1] = new_max
        else:
            groups.append([note])
            group_min_pitch.append(note.pitch)
            group_max_pitch.append(note.pitch)

    merged = []
    for group in groups:
        longest = max(group, key=lambda n: n.end - n.start)
        merged.append(
            pretty_midi.Note(
                velocity=max(n.velocity for n in group),
                pitch=longest.pitch,
                start=group[0].start,
                end=group[-1].end,
            )
        )
    return merged


def enforce_monophony(notes: list[pretty_midi.Note]) -> list[pretty_midi.Note]:
    """A single voice can't sing two pitches at once. Basic Pitch is a polyphonic
    transcriber though, so overlapping notes in its output are spurious (harmonic
    bleed-through, octave doubling) rather than real chords. For each overlap, keep
    whichever note Basic Pitch was more confident about (higher velocity/amplitude) and
    trim or drop the other, instead of keeping both as if the singer harmonized with
    themselves."""
    result: list[pretty_midi.Note] = []
    for note in notes:
        if not result or note.start >= result[-1].end:
            result.append(note)
            continue

        last = result[-1]
        if note.velocity > last.velocity:
            if note.start <= last.start:
                result.pop()
            else:
                last.end = note.start
            result.append(note)
        elif note.end > last.end:
            note.start = last.end
            result.append(note)
        # else: note is fully covered by a stronger last note -- drop it.

    # Safety net: guarantee strictly non-overlapping output even in edge cases the
    # velocity-based resolution above doesn't cleanly cover.
    safe: list[pretty_midi.Note] = []
    for note in result:
        if safe and note.start < safe[-1].end:
            note.start = safe[-1].end
        if note.end > note.start:
            safe.append(note)

    return safe


def remove_passing_blips(notes: list[pretty_midi.Note]) -> list[pretty_midi.Note]:
    if len(notes) < 3:
        return notes

    result = [notes[0]]
    i = 1
    while i < len(notes) - 1:
        note = notes[i]
        next_note = notes[i + 1]
        prev_note = result[-1]

        is_short = (note.end - note.start) < BLIP_MAX_DURATION
        neighbors_agree = abs(prev_note.pitch - next_note.pitch) <= BLIP_NEIGHBOR_PITCH_TOLERANCE
        differs_from_neighbors = abs(note.pitch - prev_note.pitch) > VIBRATO_PITCH_TOLERANCE
        is_weaker_than_neighbors = note.velocity < min(prev_note.velocity, next_note.velocity)

        if is_short and neighbors_agree and differs_from_neighbors and is_weaker_than_neighbors:
            prev_note.end = next_note.end
            prev_note.velocity = max(prev_note.velocity, next_note.velocity)
            i += 2
            continue

        result.append(note)
        i += 1

    if i == len(notes) - 1:
        result.append(notes[-1])

    return result


def clean_notes(midi: pretty_midi.PrettyMIDI) -> list[pretty_midi.Note]:
    if not midi.instruments:
        raise NoNotesDetectedError(
            "Basic Pitch produced no instruments -- input may be silent or non-vocal."
        )

    notes = midi.instruments[0].notes
    print("Raw notes:", len(notes))

    notes = [
        note
        for note in notes
        if MIN_PITCH <= note.pitch <= MAX_PITCH and note.velocity >= MIN_VELOCITY
    ]
    notes.sort(key=lambda note: note.start)
    print("After filtering:", len(notes))

    notes = merge_vibrato_fragments(notes)
    print("After merging vibrato fragments:", len(notes))

    notes = enforce_monophony(notes)
    print("After enforcing monophony:", len(notes))

    notes = remove_passing_blips(notes)
    print("After removing passing blips:", len(notes))

    notes = [note for note in notes if (note.end - note.start) >= MIN_DURATION]
    print("Final notes:", len(notes))

    if not notes:
        raise NoNotesDetectedError(
            "No notes survived cleaning -- input may be silent, too noisy, or non-vocal."
        )

    return notes


def build_clean_midi(notes: list[pretty_midi.Note]) -> pretty_midi.PrettyMIDI:
    midi = pretty_midi.PrettyMIDI()
    piano = pretty_midi.Instrument(program=0)

    for note in notes:
        piano.notes.append(
            pretty_midi.Note(
                velocity=max(50, min(127, note.velocity)),
                pitch=note.pitch,
                start=note.start,
                end=note.end,
            )
        )

    midi.instruments.append(piano)
    return midi


# ==========================
# NOTE EXPORT
# ==========================

def export_notes(notes: list[pretty_midi.Note], json_path: Path, csv_path: Path) -> None:
    rows = []
    for note in notes:
        start = round(note.start, 2)
        end = round(note.end, 2)
        pitch = int(note.pitch)
        rows.append(
            {
                "start_time_sec": float(start),
                "end_time_sec": float(end),
                "duration_sec": float(round(end - start, 2)),
                "pitch_midi": pitch,
                "note_name": pretty_midi.note_number_to_name(pitch),
            }
        )

    with open(json_path, "w") as f:
        json.dump(rows, f, indent=2)
    print("Saved:", json_path)

    with open(csv_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print("Saved:", csv_path)

    print("\nDetected notes:")
    for row in rows:
        print(
            f"  {row['start_time_sec']:>7.2f}s - {row['end_time_sec']:>7.2f}s  "
            f"{row['note_name']:<4} ({row['pitch_midi']})  dur={row['duration_sec']:.2f}s"
        )


# ==========================
# PIANO PREVIEW
# ==========================

def ensure_soundfont() -> Path:
    override = os.environ.get("VOCAL_PIPELINE_SOUNDFONT")
    if override:
        override_path = Path(override)
        if not override_path.exists():
            raise FileNotFoundError(f"VOCAL_PIPELINE_SOUNDFONT points at a missing file: {override_path}")
        return override_path

    if SOUNDFONT_CACHE_PATH.exists():
        return SOUNDFONT_CACHE_PATH

    SOUNDFONT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Downloading soundfont to {SOUNDFONT_CACHE_PATH} (first run only)...")

    response = requests.get(DEFAULT_SOUNDFONT_URL, stream=True, timeout=120)
    response.raise_for_status()

    tmp_path = SOUNDFONT_CACHE_PATH.with_suffix(".sf2.part")
    with open(tmp_path, "wb") as f:
        for chunk in response.iter_content(chunk_size=1 << 20):
            f.write(chunk)
    tmp_path.rename(SOUNDFONT_CACHE_PATH)

    print("Soundfont ready.")
    return SOUNDFONT_CACHE_PATH


def render_piano_preview(midi: pretty_midi.PrettyMIDI, output_path: Path) -> None:
    soundfont = ensure_soundfont()

    print("Rendering piano preview...")
    wave = midi.fluidsynth(fs=44100, sf2_path=str(soundfont))
    sf.write(str(output_path), wave, 44100)
    print("Saved:", output_path)


# ==========================
# MAIN
# ==========================

def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe an isolated vocal stem into piano notes.")
    parser.add_argument(
        "vocals_wav",
        type=Path,
        help="Path to the isolated vocal stem, e.g. separated/htdemucs_ft/<song>/vocals.wav",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("."),
        help="Directory to write outputs into (default: current directory)",
    )
    parser.add_argument(
        "--no-preview",
        action="store_true",
        help="Skip rendering the piano-preview audio file",
    )
    args = parser.parse_args()

    if not args.vocals_wav.exists():
        parser.error(f"Input file not found: {args.vocals_wav}")

    args.output_dir.mkdir(parents=True, exist_ok=True)

    midi = transcribe_to_midi(args.vocals_wav)
    notes = clean_notes(midi)
    clean_midi = build_clean_midi(notes)

    clean_midi_path = args.output_dir / "cleaned_melody.mid"
    clean_midi.write(str(clean_midi_path))
    print("Saved:", clean_midi_path)

    export_notes(
        notes,
        args.output_dir / "melody_notes.json",
        args.output_dir / "melody_notes.csv",
    )

    if not args.no_preview:
        try:
            render_piano_preview(clean_midi, args.output_dir / "piano_preview.wav")
        except Exception as exc:
            print(f"Warning: piano preview render failed ({exc}). Notes and MIDI were still saved.")


if __name__ == "__main__":
    main()
