#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Generate v3 cinematic audio: strings+piano music + 6 SFX + new narration."""
import asyncio, edge_tts, os, subprocess, sys

OUT_DIR = r"E:\AI改编游戏\hidden-object-web\apps\web\public\content\outros"

# ============================================================
# 1) Narration: new poetic text, 4 segments aligned to scenes
# ============================================================
# Scenes (camera beats):
#   0.0-3.0s : detective desk
#   3.0-6.0s : archive
#   6.0-9.0s : harbor cabin
#   9.0-12.0s: clocktower vault
#  12.0-15.0s: mapmaker workshop at dawn (REVEAL)

NARRATION_SEGMENTS = [
    # (start, end, text)
    (0.0,  3.0,  "沈砚没有失踪。"),
    (3.0,  7.5,  "他留下线索，穿过档案、雾港与钟塔，"),
    (7.5, 11.5,  "只为完成潮汐星图。"),
    (11.5, 15.0, "晨光抵达工坊，走私航线终于显影。"),
]

VOICE = "zh-CN-YunjianNeural"
RATE  = "-12%"   # slower for solemn cinematic pace
PITCH = "-3Hz"

async def synth_all():
    os.makedirs(OUT_DIR, exist_ok=True)
    paths = []
    for i, (start, end, text) in enumerate(NARRATION_SEGMENTS, 1):
        out = os.path.join(OUT_DIR, f"v3-narration-{i}.mp3")
        com = edge_tts.Communicate(text, VOICE, rate=RATE, pitch=PITCH)
        await com.save(out)
        paths.append((start, end, out))
        print(f"  narration-{i}: [{start}-{end}s] {text}  ({os.path.getsize(out)//1024} KB)")
    return paths

if __name__ == "__main__":
    asyncio.run(synth_all())
    print("Narration ready.")