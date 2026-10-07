"""Write caprice<N>-norepeat.mid: the unfolded MIDI with each immediately-repeated block played once."""
import sys

import mido

n = sys.argv[1]
src = mido.MidiFile(f"caprice{n}.mid")
tpb = src.ticks_per_beat

# Absolute-time events per track.
tracks = []
for track in src.tracks:
    t, events = 0, []
    for msg in track:
        t += msg.time
        events.append((t, msg))
    tracks.append(events)

# Onset sequence (tick, pitch) across all tracks, chords as sorted tuples per tick.
by_tick = {}
for events in tracks:
    for t, m in events:
        if m.type == "note_on" and m.velocity > 0:
            by_tick.setdefault(t, []).append(m.note)
ticks = sorted(by_tick)
seq = [tuple(sorted(by_tick[t])) for t in ticks]
iois = [ticks[i + 1] - ticks[i] for i in range(len(ticks) - 1)] + [0]

# Greedy scan: at each position, the longest block (>= 12 onsets) that is immediately repeated
# with the same pitches and the same rhythm. Remove the second copy.
cuts = []  # (start_tick, end_tick) of removed copies
i = 0
while i < len(seq):
    best = 0
    for L in range(min(400, (len(seq) - i) // 2), 11, -1):
        if seq[i:i + L] == seq[i + L:i + 2 * L] and iois[i:i + L - 1] == iois[i + L:i + 2 * L - 1]:
            best = L
            break
    if best:
        start = ticks[i + best]
        end = ticks[i + 2 * best] if i + 2 * best < len(ticks) else ticks[-1] + iois[i + best - 1]
        cuts.append((start, end))
        i += 2 * best
    else:
        i += 1

def removed_before(t):
    return sum(min(e, t) - s for s, e in cuts if s < t)

def inside_cut(t):
    return any(s <= t < e for s, e in cuts)

out = mido.MidiFile(ticks_per_beat=tpb, type=src.type)
for events in tracks:
    new, last = mido.MidiTrack(), 0
    open_notes = set()
    for t, m in events:
        if m.type == "end_of_track":
            continue
        is_on = m.type == "note_on" and m.velocity > 0
        is_off = m.type == "note_off" or (m.type == "note_on" and m.velocity == 0)
        if inside_cut(t):
            # Keep note-offs for notes started before the cut so nothing hangs.
            if is_off and (m.channel, m.note) in open_notes:
                pass
            else:
                continue
        if is_on:
            open_notes.add((m.channel, m.note))
        if is_off:
            open_notes.discard((m.channel, m.note))
        nt = t - removed_before(t)
        new.append(m.copy(time=max(0, nt - last)))
        last = max(last, nt)
    new.append(mido.MetaMessage("end_of_track", time=0))
    out.tracks.append(new)
out.save(f"caprice{n}-norepeat.mid")
print(f"caprice {n}: removed {len(cuts)} repeated blocks totalling {sum(e - s for s, e in cuts) / tpb:.1f} qn "
      f"(of {ticks[-1] / tpb:.1f}); blocks at qn " + ", ".join(f"{s / tpb:.0f}-{e / tpb:.0f}" for s, e in cuts))
