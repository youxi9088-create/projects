#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Generate v3 cinematic audio in stages: music, SFX, narration, then mix."""
import os, subprocess, sys

OUT_DIR = r"E:\AI改编游戏\hidden-object-web\apps\web\public\content\outros"

NOTE = {
    'D2':73.42,'A2':110.00,'Bb2':116.54,
    'C3':130.81,'D3':146.83,'Eb3':155.56,'F3':174.61,'F#3':185.00,'A3':220.00,'Bb3':233.08,
    'C4':261.63,'Db4':277.18,'D4':293.66,'E4':329.63,'F4':349.23,'F#4':369.99,'A4':440.00,'Bb4':466.16,
    'C5':523.25,'Db5':554.37,'D5':587.33,'E5':659.25,'F5':698.46,'F#5':739.99,'A5':880.00,'Bb5':932.33,
}

# Five chord slots, each (start, end, strings, pianos, vol_s, vol_p)
CHORDS = [
    (0.0,  3.0,  ['D3','F3','A3'],                       [],                              0.10, 0.0),
    (3.0,  6.0,  ['A3','C4','E4'],                       ['A4','C5','E5'],                0.10, 0.08),
    (6.0,  9.0,  ['Bb3','Db4','F4'],                     ['Bb4','Db5','F5'],              0.12, 0.09),
    (9.0, 12.0,  ['D3','F3','A3','C4'],                  ['D4','F4','A4','C5'],           0.13, 0.10),
    (12.0,15.04, ['D3','F#3','A3','D4','F#4','A4'],      ['D5','F#5','A5'],               0.20, 0.14),
]


def run_ffmpeg(args, desc):
    print(f"\n>>> {desc}")
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        print("STDERR:", r.stderr[-1500:])
        sys.exit(1)
    print(f"OK ({r.stderr.strip().split(chr(10))[-1] if r.stderr.strip() else 'done'})")


# ============================================================
# Stage 1: Music (strings + piano chord progression + drone)
# ============================================================
def gen_music():
    sfreqs = sorted({NOTE[n] for _,_,s,_,_,_ in CHORDS for n in s})
    pfreqs = sorted({NOTE[n] for _,_,_,p,_,_ in CHORDS for n in p})

    args = ["ffmpeg", "-y"]
    args += ["-f", "lavfi", "-i", "anoisesrc=color=brown:duration=15.04:amplitude=0.22"]  # 0: rain
    args += ["-f", "lavfi", "-i", f"sine=frequency={NOTE['D2']}:duration=15.04"]          # 1: drone

    idx = 2
    sidx = {}
    for f in sfreqs:
        sidx[f] = idx
        args += ["-f", "lavfi", "-i", f"sine=frequency={f}:duration=15.04"]
        idx += 1
    pidx = {}
    for f in pfreqs:
        pidx[f] = idx
        args += ["-f", "lavfi", "-i", f"sine=frequency={f}:duration=15.04"]
        idx += 1

    fc = []

    # Process each chord
    for ci, (start, end, sn, pn, svol, pvol) in enumerate(CHORDS):
        fade_out = end - 0.5
        if sn:
            sis = [sidx[NOTE[n]] for n in sn]
            mixin = "".join(f"[{i}:a]" for i in sis)
            fc.append(
                f"{mixin}amix=inputs={len(sis)}:duration=longest,"
                f"afade=t=in:st={start}:d=0.4,afade=t=out:st={fade_out}:d=0.5,"
                f"vibrato=f=4:d=0.3,"
                f"aecho=0.8:0.85:1000:0.5,lowpass=f=2000,"
                f"volume={svol}[s{ci}]"
            )
        if pn:
            pis = [pidx[NOTE[n]] for n in pn]
            mixin = "".join(f"[{i}:a]" for i in pis)
            fc.append(
                f"{mixin}amix=inputs={len(pis)}:duration=longest,"
                f"afade=t=in:st={start}:d=0.05,afade=t=out:st={fade_out}:d=0.5,"
                f"vibrato=f=6:d=0.2,"
                f"aecho=0.7:0.7:800:0.4,highpass=f=200,lowpass=f=5000,"
                f"volume={pvol}[p{ci}]"
            )

    # Combine chord tracks
    chord_in = "".join(f"[s{i}]" for i in range(5) if CHORDS[i][2]) + \
               "".join(f"[p{i}]" for i in range(5) if CHORDS[i][3])
    n_ch = chord_in.count('[')
    fc.append(f"{chord_in}amix=inputs={n_ch}:duration=longest[chords]")

    fc.append(f"[1:a]volume=0.06,tremolo=f=2:d=0.4,aecho=0.8:0.8:800:0.4[drone]")
    fc.append(f"[chords][drone]amix=inputs=2:duration=longest:weights=1 0.5[music]")

    out = os.path.join(OUT_DIR, "v3-music.wav")
    args += ["-filter_complex", ";\n".join(fc), "-map", "[music]",
             "-c:a", "pcm_s16le", "-ar", "44100", out]
    run_ffmpeg(args, "Generating music (strings + piano chord progression)")
    return out


# ============================================================
# Stage 2: SFX (rain + tick + paper + foghorn + bell + reveal)
# ============================================================
def gen_sfx():
    # SFX sources:
    # 0: rain (brown noise filtered)
    # 1: tick tone (2500Hz)
    # 2: paper (white noise filtered)
    # 3: foghorn (120Hz)
    # 4: bell base (300Hz)
    # 5: bell harmonic 1 (900Hz)
    # 6: bell harmonic 2 (1800Hz)
    # 7: reveal tone (2500Hz with vibrato)
    # 8: reveal noise (high-freq white noise)

    args = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "anoisesrc=color=brown:duration=15.04:amplitude=0.22",  # 0
        "-f", "lavfi", "-i", "sine=frequency=2500:duration=0.05",                      # 1
        "-f", "lavfi", "-i", "anoisesrc=color=white:duration=0.6:amplitude=0.5",       # 2
        "-f", "lavfi", "-i", "sine=frequency=120:duration=2.5",                         # 3
        "-f", "lavfi", "-i", "sine=frequency=300:duration=1.8",                         # 4
        "-f", "lavfi", "-i", "sine=frequency=900:duration=1.5",                         # 5
        "-f", "lavfi", "-i", "sine=frequency=1800:duration=1.2",                        # 6
        "-f", "lavfi", "-i", "sine=frequency=2500:duration=0.8",                        # 7
        "-f", "lavfi", "-i", "anoisesrc=color=white:duration=0.8:amplitude=0.4",        # 8
    ]

    fc = []

    # Rain: filtered brown noise
    fc.append(f"[0:a]highpass=f=400,lowpass=f=2500,volume=0.32[rain]")

    # Tick: every ~1s, brief 2500Hz click
    tick_times = [0.3, 0.8, 1.5, 2.2, 3.3, 4.5, 5.8, 7.2, 8.5, 9.7, 11.0, 12.5, 13.8]
    for i, t in enumerate(tick_times):
        ms = int(t * 1000)
        fc.append(f"[1:a]adelay={ms}|{ms},volume=0.4[tk{i}]")
    fc.append("".join(f"[tk{i}]" for i in range(len(tick_times))) +
              f"amix=inputs={len(tick_times)}:duration=longest:normalize=0[ticks]")

    # Paper: 1.2s start, 0.6s
    fc.append(f"[2:a]adelay=1200|1200,highpass=f=800,lowpass=f=4000,volume=0.5[paper]")

    # Foghorn: 6.5s start, 2.5s
    fc.append(
        f"[3:a]adelay=6500|6500,"
        f"afade=t=in:st=0:d=0.5,afade=t=out:st=2.2:d=0.3,"
        f"tremolo=f=3:d=0.4,volume=0.4,lowpass=f=400[foghorn]"
    )

    # Bells: two strikes at 9.5s and 12.2s
    for bi, t in enumerate([9.5, 12.2]):
        ms = int(t * 1000)
        d = 1.8 if bi == 0 else 1.5
        lbl = f"bell{bi}"
        fc.append(
            f"[4:a]adelay={ms}|{ms},volume=0.5,afade=t=out:st={d-0.2}:d=1.5,lowpass=f=600[{lbl}a];"
            f"[5:a]adelay={ms}|{ms},volume=0.3,afade=t=out:st={d-0.2}:d=1.2,lowpass=f=1500[{lbl}b];"
            f"[6:a]adelay={ms}|{ms},volume=0.2,afade=t=out:st={d-0.2}:d=1.0,lowpass=f=3000[{lbl}c];"
            f"[{lbl}a][{lbl}b][{lbl}c]amix=inputs=3:duration=longest[{lbl}]"
        )

    # Reveals: two shimmer hits at 12.8s and 14.0s
    for ri, t in enumerate([12.8, 14.0]):
        ms = int(t * 1000)
        d = 0.8 if ri == 0 else 0.6
        fc.append(
            f"[7:a]adelay={ms}|{ms},vibrato=f=10:d=0.4,volume=0.4,"
            f"afade=t=out:st={d-0.1}:d=0.3,highpass=f=1500,lowpass=f=5000[r{ri}t];"
            f"[8:a]adelay={ms}|{ms},highpass=f=2000,lowpass=f=6000,volume=0.3,"
            f"afade=t=out:st={d-0.1}:d=0.3[r{ri}s];"
            f"[r{ri}t][r{ri}s]amix=inputs=2:duration=longest[r{ri}]"
        )

    # Combine all SFX
    sfx_labels = ["[ticks]", "[paper]", "[foghorn]", "[bell0]", "[bell1]", "[r0]", "[r1]"]
    fc.append("".join(sfx_labels) + f"amix=inputs={len(sfx_labels)}:duration=longest:normalize=0[sfx]")

    # Final mix: SFX + rain
    fc.append(f"[sfx][rain]amix=inputs=2:duration=longest:weights=1 0.5[sfx_rain]")

    out = os.path.join(OUT_DIR, "v3-sfx.wav")
    args += ["-filter_complex", ";\n".join(fc), "-map", "[sfx_rain]",
             "-c:a", "pcm_s16le", "-ar", "44100", out]
    run_ffmpeg(args, "Generating SFX (tick + paper + foghorn + bell + reveal + rain)")
    return out


# ============================================================
# Stage 3: Mix music + SFX + narration into final track
# ============================================================
def gen_final(music_path, sfx_path):
    # Narration files
    nar = [f"v3-narration-{i}.mp3" for i in range(1, 5)]
    nar_paths = [os.path.join(OUT_DIR, n) for n in nar]

    # Time alignment (start, end in ms)
    # 0-3000, 3000-7500, 7500-11500, 11500-15000
    delays = [0, 3000, 7500, 11500]

    args = ["ffmpeg", "-y",
            "-i", music_path,
            "-i", sfx_path]
    for p in nar_paths:
        args += ["-i", p]

    fc = []

    # Apply adelay to each narration
    for i, d in enumerate(delays):
        fc.append(f"[{i+2}:a]adelay={d}|{d},volume=1.0[n{i}]")

    # Mix narrations
    fc.append("".join(f"[n{i}]" for i in range(4)) + "amix=inputs=4:duration=longest:normalize=0[narration]")

    # Music: slightly reduce volume (so narration is clear)
    fc.append(f"[0:a]volume=0.85[music]")
    # SFX: keep as is
    fc.append(f"[1:a]volume=1.0[sfx]")

    # Mix music + SFX
    fc.append(f"[music][sfx]amix=inputs=2:duration=longest:weights=1 0.7[ms]")
    # Add narration on top
    fc.append(f"[ms][narration]amix=inputs=2:duration=longest:weights=1 1.2[final]")

    out = os.path.join(OUT_DIR, "v3-final-audio.wav")
    args += ["-filter_complex", ";\n".join(fc), "-map", "[final]",
             "-c:a", "pcm_s16le", "-ar", "44100", out]
    run_ffmpeg(args, "Mixing music + SFX + narration")
    return out


# ============================================================
# Stage 4: Replace audio in mystery-finale.mp4
# ============================================================
def replace_video_audio(audio_path):
    # Source: the freshly-prepared base video (with delogo + subtitles baked in)
    src = os.path.join(OUT_DIR, "mystery-finale-base.mp4")
    # Write to temp file first to avoid same-file read/write race
    tmp_out = os.path.join(OUT_DIR, "mystery-finale-tmp.mp4")
    final_out = os.path.join(OUT_DIR, "mystery-finale.mp4")
    args = ["ffmpeg", "-y",
            "-i", src,
            "-i", audio_path,
            "-map", "0:v", "-map", "1:a",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
            "-shortest", "-movflags", "+faststart",
            tmp_out]
    run_ffmpeg(args, "Replacing audio -> temp file")
    # Move temp to final (overwriting old)
    if os.path.exists(final_out):
        os.remove(final_out)
    os.rename(tmp_out, final_out)
    print(f"OK (renamed {tmp_out} -> {final_out})")


if __name__ == "__main__":
    music = gen_music()
    sfx = gen_sfx()
    final = gen_final(music, sfx)
    replace_video_audio(final)
    print("\n=== ALL DONE ===")
    print(f"Final: {os.path.join(OUT_DIR, 'mystery-finale.mp4')}")