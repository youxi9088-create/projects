#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Generate cinematic procedural music: chord progression + drone + reverb + impact."""
import os, subprocess, sys

OUT_DIR = r"E:\AI改编游戏\hidden-object-web\apps\web\public\content\outros"
PYTHON = r"C:\Users\986916\.workbuddy\binaries\python\versions\3.13.12\python.exe"

# 15-second music structure - D minor with reveal on D major
# Frequencies (Hz):
#   D2=73.42, D3=146.83, F3=174.61, F#3=185.00, G3=196.00, A3=220.00,
#   Bb3=233.08, C4=261.63, D4=293.66, E4=329.63, F4=349.23

# Chord progression (3 sec each, last chord resolves to D major):
#   0.0-3.2s  : Dm   (D-F-A)         melancholy establish
#   3.2-6.4s  : Am   (A-C-E)         moving
#   6.4-9.6s  : Bbm  (Bb-Db-F)       tension  -> substitute Db=277.18
#   9.6-12.8s : Dm9  (D-F-A-C)       deepening
#  12.8-15.04s: D    (D-F#-A)        MAJOR resolution + impact swell

CHORDS = [
    # (start, end, [frequencies], volume)
    (0.0,  3.2,  [146.83, 174.61, 220.00],               0.05),  # Dm
    (3.2,  6.4,  [220.00, 261.63, 329.63],               0.05),  # Am
    (6.4,  9.6,  [233.08, 277.18, 349.23],               0.06),  # Bbm (Db=277.18)
    (9.6, 12.8,  [146.83, 174.61, 220.00, 261.63],       0.07),  # Dm9 (adds C)
    (12.8, 15.04,[146.83, 185.00, 220.00, 293.66],       0.10),  # D major (F# resolution + D4 octave)
]

def build_chord_inputs(chords):
    """Generate -i args for sine waves + metadata."""
    inputs = []
    # Each chord voice is a unique sine source keyed by frequency
    # We pad with delay + envelope later
    used_freqs = sorted({f for _,_,freqs,_ in chords for f in freqs})
    for f in used_freqs:
        inputs.append(f"-f lavfi -i sine=frequency={f}:duration=15.04")
    return inputs, used_freqs

def build_filter_complex(chords, used_freqs):
    """Build ffmpeg filter_complex for chord progression."""
    freq_idx = {f: i+2 for i, f in enumerate(used_freqs)}  # i+2 because 0=rain, 1=drone

    parts = []

    # Process each chord: mix its notes, apply envelope, add reverb
    for ci, (start, end, freqs, vol) in enumerate(chords):
        note_labels = [f"[{freq_idx[f]}:a]" for f in freqs]
        mix_inputs = "".join(note_labels)
        n = len(freqs)
        dur = end - start
        # Build envelope: fade in over 0.4s, hold, fade out over last 0.4s
        fade_out_start = end - 0.4
        env = f"afade=t=in:st={start}:d=0.4,afade=t=out:st={fade_out_start}:d=0.4"
        # Add reverb via aecho
        reverb = "aecho=0.8:0.85:1000|1500:0.5|0.4"
        parts.append(
            f"{mix_inputs}amix=inputs={n}:duration=longest,"
            f"volume={vol},{env},{reverb}[c{ci}]"
        )

    # Drone: continuous D2 with slow tremolo via volume envelope
    parts.append(f"[1:a]volume=0.06,tremolo=f=2:d=0.3[drone]")

    # Mix all chord layers + drone
    n_chords = len(chords)
    chord_labels = "".join(f"[c{i}]" for i in range(n_chords))
    parts.append(
        f"{chord_labels}[drone]amix=inputs={n_chords+1}:duration=longest:weights="
        f"{'1 ' * n_chords}0.7[music]"
    )

    # Rain atmospheric layer (0 background, subtle)
    parts.append(f"[0:a]highpass=f=400,lowpass=f=2500,volume=0.35[rain]")

    # Final mix: music + rain
    parts.append(f"[music][rain]amix=inputs=2:duration=longest[mix]")

    return ";\n    ".join(parts)

def main():
    inputs, used_freqs = build_chord_inputs(CHORDS)
    fc = build_filter_complex(CHORDS, used_freqs)

    # Build full ffmpeg command
    # Inputs:
    #   [0] rain noise (brown noise filtered)
    #   [1] drone D2 (73.42 Hz)
    #   [2+] chord voice sine waves
    all_inputs = (
        f"-f lavfi -i \"anoisesrc=color=brown:duration=15.04:amplitude=0.22\" "
        f"-f lavfi -i \"sine=frequency=73.42:duration=15.04\" "
        + " ".join(inputs)
    )

    out_path = os.path.join(OUT_DIR, "mystery-finale-music.wav")
    cmd = (
        f'"{PYTHON}" -c "" 2>/dev/null; '  # ensure PYTHON available
    )
    # Actually use ffmpeg directly
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "anoisesrc=color=brown:duration=15.04:amplitude=0.22",
        "-f", "lavfi", "-i", "sine=frequency=73.42:duration=15.04",
    ]
    for f in used_freqs:
        cmd += ["-f", "lavfi", "-i", f"sine=frequency={f}:duration=15.04"]

    cmd += [
        "-filter_complex", fc,
        "-map", "[mix]",
        "-c:a", "pcm_s16le",
        "-ar", "44100",
        out_path,
    ]

    print("Running ffmpeg...")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print("STDERR:", result.stderr[-2000:])
        sys.exit(1)
    print(f"Generated: {out_path}  ({os.path.getsize(out_path)//1024} KB)")

if __name__ == "__main__":
    main()