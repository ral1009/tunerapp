import torch
import librosa
import numpy as np

import pretty_midi
import soundfile as sf

from scipy.signal import medfilt


# ==========================
# SETTINGS
# ==========================

AUDIO = "vocals.wav"

RMVPE_MODEL = "model.pt"

OUTPUT_MIDI = "rmvpe_melody.mid"

OUTPUT_AUDIO = "rmvpe_piano.wav"


SR = 16000

HOP_LENGTH = 160


MIN_NOTE_LENGTH = 0.12

PITCH_THRESHOLD = 0.6



# ==========================
# LOAD RMVPE
# ==========================

from rmvpe import RMVPE


device = "cuda" if torch.cuda.is_available() else "cpu"


print(
    "Device:",
    device
)


model = RMVPE(
    RMVPE_MODEL,
    device=device
)



# ==========================
# LOAD AUDIO
# ==========================

audio, sr = librosa.load(
    AUDIO,
    sr=SR,
    mono=True
)



# ==========================
# EXTRACT F0
# ==========================

print(
    "Extracting pitch..."
)


f0 = model.infer_from_audio(
    audio,
    thred=0.03
)


f0 = np.array(f0)



print(
    "Frames:",
    len(f0)
)



# ==========================
# CLEAN PITCH
# ==========================

# remove unvoiced

f0[f0 < 50] = np.nan


# smooth pitch

valid = ~np.isnan(f0)


filled = f0.copy()


filled[~valid] = np.nanmedian(
    f0
)


filled = medfilt(
    filled,
    kernel_size=7
)



# ==========================
# F0 -> MIDI
# ==========================


midi_pitch=[]


for hz in filled:

    if np.isnan(hz):

        midi_pitch.append(None)

    else:

        midi_pitch.append(
            69 + 12*np.log2(
                hz/440
            )
        )



# ==========================
# NOTE SEGMENTATION
# ==========================

frame_time = HOP_LENGTH / SR


notes=[]

current=[]

start=None



for i,pitch in enumerate(midi_pitch):


    if pitch is None:


        if current:

            duration = (
                i-start
            )*frame_time


            if duration > MIN_NOTE_LENGTH:

                notes.append(
                    (
                        np.mean(current),
                        start,
                        i
                    )
                )


            current=[]

            start=None


        continue



    if start is None:

        start=i
        current=[pitch]

    else:

        mean_pitch=np.mean(current)


        if abs(
            pitch-mean_pitch
        ) > PITCH_THRESHOLD:


            duration=(
                i-start
            )*frame_time


            if duration > MIN_NOTE_LENGTH:

                notes.append(
                    (
                        np.mean(current),
                        start,
                        i
                    )
                )


            start=i
            current=[pitch]


        else:

            current.append(
                pitch
            )



print(
    "Notes:",
    len(notes)
)



# ==========================
# CREATE MIDI
# ==========================

midi = pretty_midi.PrettyMIDI()


instrument = pretty_midi.Instrument(
    program=0
)



for pitch,start,end in notes:


    instrument.notes.append(

        pretty_midi.Note(

            velocity=100,

            pitch=int(round(pitch)),

            start=start*frame_time,

            end=end*frame_time

        )

    )



midi.instruments.append(
    instrument
)


midi.write(
    OUTPUT_MIDI
)



print(
    "Saved:",
    OUTPUT_MIDI
)



# ==========================
# RENDER PIANO
# ==========================


wave = midi.fluidsynth(
    fs=44100
)


sf.write(
    OUTPUT_AUDIO,
    wave,
    44100
)


print(
    "Saved:",
    OUTPUT_AUDIO
)