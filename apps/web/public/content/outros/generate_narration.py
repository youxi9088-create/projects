#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Generate Chinese narration using edge-tts (Microsoft Edge online TTS, free)."""
import asyncio
import edge_tts
import os

OUT_DIR = r"E:\AI改编游戏\hidden-object-web\apps\web\public\content\outros"

# Five narration segments aligned to camera beats
# Voice: zh-CN-YunjianNeural - mature, suspenseful male (good for mystery narration)
SEGMENTS = [
    (0.0,   3.2, "雨夜未歇，案台之上。",                                          "narration-01-rain-desk.wav"),
    (3.2,   6.4, "档案泛黄，金线浮起。",                                          "narration-02-archive.wav"),
    (6.4,   9.6, "浓雾锁港，夜鸦号隐现。",                                        "narration-03-harbor.wav"),
    (9.6,  12.8, "钟楼滴答，真相将至。",                                          "narration-04-clocktower.wav"),
    (12.8, 15.0, "黎明破晓，潮汐星图告成。走私船队，无所遁形。",                  "narration-05-finale.wav"),
]

# zh-CN-YunjianNeural  = 云健（成熟男声，悬疑感强）
# zh-CN-YunxiNeural    = 云希（年轻男声）
# zh-CN-YunyangNeural  = 云扬（新闻男声，沉稳）
# zh-CN-XiaoxiaoNeural = 晓晓（温暖女声）
VOICE = "zh-CN-YunjianNeural"
RATE  = "-8%"   # slower than normal for cinematic pacing
PITCH = "-2Hz"  # slightly lower pitch for gravitas

async def synth_one(text, out_path):
    communicate = edge_tts.Communicate(text, VOICE, rate=RATE, pitch=PITCH)
    await communicate.save(out_path)
    return out_path

async def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for start, end, text, fname in SEGMENTS:
        out_path = os.path.join(OUT_DIR, fname)
        await synth_one(text, out_path)
        size = os.path.getsize(out_path)
        print(f"  [{start:5.1f}-{end:5.1f}] {fname}  ({size//1024} KB)  text: {text}")

if __name__ == "__main__":
    asyncio.run(main())
    print("\nAll narration segments generated.")