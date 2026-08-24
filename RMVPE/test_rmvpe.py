import torch
import librosa

from src.model import E2E
from src.inference import Inference
from src.constants import *


DEVICE = "cpu"

AUDIO = "vocals.wav"

MODEL_PATH = "rmvpe.pth"


# load audio

audio, sr = librosa.load(
    AUDIO,
    sr=SAMPLE_RATE,
    mono=True
)


audio = torch.tensor(
    audio,
    dtype=torch.float32
).to(DEVICE)



# create model

model = E2E(
    hop_length=HOP_LENGTH,
    n_blocks=4,
    n_gru=2,
    kernel_size=3
)


checkpoint = torch.load(
    MODEL_PATH,
    map_location=DEVICE
)


model.load_state_dict(
    checkpoint
)


model.to(DEVICE)



infer = Inference(
    model,
    seg_len=SEG_LEN,
    seg_frames=SEG_FRAMES,
    hop_length=HOP_LENGTH,
    batch_size=1,
    device=DEVICE
)



hidden, output = infer.inference(
    audio
)


print(output.shape)