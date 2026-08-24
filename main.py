import os
import subprocess
import pretty_midi
import librosa
import soundfile as sf
import numpy as np


# ==========================
# SETTINGS
# ==========================

INPUT_AUDIO = "separated/htdemucs_ft/golden/vocals.wav"

OUTPUT_DIR = "basic_pitch_output"

RAW_MIDI = None

CLEAN_MIDI = "cleaned_melody1.mid"

PREVIEW_AUDIO = "piano_preview1.wav"


# Vocal range limits
# roughly C2-C7
MIN_PITCH = 36
MAX_PITCH = 96


# remove tiny artifacts
MIN_DURATION = 0.12


# merge notes if gap smaller than this
MERGE_GAP = 0.08


# ==========================
# RUN BASIC PITCH
# ==========================

print("Running Basic Pitch...")


os.makedirs(
    OUTPUT_DIR,
    exist_ok=True
)


subprocess.run(
    [
        "basic-pitch",
        OUTPUT_DIR,
        INPUT_AUDIO
    ]
)



# find midi file

for file in os.listdir(OUTPUT_DIR):

    if file.endswith(".mid"):

        RAW_MIDI = os.path.join(
            OUTPUT_DIR,
            file
        )


if RAW_MIDI is None:

    raise Exception(
        "No MIDI produced"
    )


print(
    "MIDI:",
    RAW_MIDI
)



# ==========================
# LOAD MIDI
# ==========================

midi = pretty_midi.PrettyMIDI(
    RAW_MIDI
)


instrument = midi.instruments[0]


notes = instrument.notes


print(
    "Raw notes:",
    len(notes)
)



# ==========================
# CLEAN NOTES
# ==========================


clean = []


for note in notes:


    duration = (
        note.end -
        note.start
    )


    # remove short noise

    if duration < MIN_DURATION:
        continue



    # remove impossible pitches

    if note.pitch < MIN_PITCH:
        continue


    if note.pitch > MAX_PITCH:
        continue



    clean.append(note)



print(
    "After filtering:",
    len(clean)
)



# sort

clean.sort(
    key=lambda x:x.start
)



# ==========================
# MERGE SAME NOTES
# ==========================


merged=[]


for note in clean:


    if len(merged)==0:

        merged.append(note)
        continue



    prev = merged[-1]


    same_pitch = (
        abs(prev.pitch-note.pitch)<=0
    )


    close = (
        note.start-prev.end
        <
        MERGE_GAP
    )


    if same_pitch and close:


        prev.end = note.end


    else:

        merged.append(note)



print(
    "After merging:",
    len(merged)
)



# ==========================
# REMOVE ISOLATED OUTLIERS
# ==========================


final=[]


for i,note in enumerate(merged):


    neighbors=[]


    if i>0:
        neighbors.append(
            merged[i-1].pitch
        )


    if i<len(merged)-1:
        neighbors.append(
            merged[i+1].pitch
        )



    # remove crazy one-frame jumps

    if len(neighbors)>0:

        diff=np.mean(
            [
                abs(note.pitch-x)
                for x in neighbors
            ]
        )


        if diff>12:
            continue



    final.append(note)



print(
    "Final notes:",
    len(final)
)



# ==========================
# SAVE CLEAN MIDI
# ==========================


new_midi = pretty_midi.PrettyMIDI()


piano = pretty_midi.Instrument(
    program=0
)


for note in final:


    piano.notes.append(

        pretty_midi.Note(

            velocity=100,

            pitch=note.pitch,

            start=note.start,

            end=note.end

        )

    )


new_midi.instruments.append(
    piano
)


new_midi.write(
    CLEAN_MIDI
)



print(
    "Saved:",
    CLEAN_MIDI
)



# ==========================
# RENDER PIANO
# ==========================

print(
    "Rendering piano..."
)


wave = new_midi.fluidsynth(
    fs=44100
)


sf.write(
    PREVIEW_AUDIO,
    wave,
    44100
)


print(
    "Saved:",
    PREVIEW_AUDIO
)