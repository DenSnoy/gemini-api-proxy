#!/usr/bin/env python3
"""Direct Gemini Live WebSocket → complete WAV, no TTS, Cloudflare, or Live SDK."""
import argparse
import asyncio
import base64
import json
import os
import tempfile
import wave
from pathlib import Path
from urllib.parse import quote

import websockets

RATE = 24000
MODEL = "gemini-3.8-live"
ENDPOINT = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)


def options():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--prompt", required=True)
    p.add_argument("--voice", default="Leda")
    p.add_argument("--model", default=MODEL)
    p.add_argument("--min-seconds", type=float, default=25)
    p.add_argument("--max-seconds", type=float, default=45)
    p.add_argument("--timeout-seconds", type=float, default=110)
    p.add_argument("--attempts", type=int, default=2)
    p.add_argument("--output", default="output/gemini-live.wav")
    return p.parse_args()


def setup(model, voice):
    return {
        "setup": {
            "model": "models/" + model.removeprefix("models/"),
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {
                    "voiceConfig": {
                        "prebuiltVoiceConfig": {"voiceName": voice}
                    }
                },
            },
            "systemInstruction": {
                "parts": [{
                    "text": (
                        "You are a cheerful musical singer. When asked to sing, "
                        "use actual pitches and a steady melody, never speak the lyrics. "
                        "No introductions, no extra spoken text."
                    )
                }]
            },
        }
    }


def chunks_from_message(message):
    parts = (message.get("serverContent", {}).get("modelTurn") or {}).get("parts") or []
    result = []
    for part in parts:
        audio = part.get("inlineData") or {}
        if not audio.get("data"):
            continue
        mime = (audio.get("mimeType") or "").lower()
        if not mime.startswith("audio/pcm"):
            raise RuntimeError("Unexpected audio format: " + mime[:100])
        if "rate=" in mime and "rate=24000" not in mime:
            raise RuntimeError("Unexpected audio sample rate: " + mime[:100])
        result.append(base64.b64decode(audio["data"], validate=True))
    return result


async def live_turn(args, key):
    url = ENDPOINT + "?key=" + quote(key, safe="")
    received = bytearray()
    ready = False
    complete = False
    async with websockets.connect(
        url, open_timeout=15, close_timeout=3, max_size=20 * 1024 * 1024
    ) as ws:
        await ws.send(json.dumps(setup(args.model, args.voice)))
        async with asyncio.timeout(args.timeout_seconds):
            async for frame in ws:
                data = json.loads(frame)
                if data.get("error"):
                    error = data["error"]
                    raise RuntimeError("Google Live: " + str(error.get("message", error))[:250])
                if "setupComplete" in data:
                    ready = True
                    await ws.send(json.dumps({
                        "clientContent": {
                            "turns": [{
                                "role": "user",
                                "parts": [{"text": args.prompt}],
                            }],
                            "turnComplete": True
                        }
                    }))
                    continue
                sc = data.get("serverContent") or {}
                if sc.get("interrupted"):
                    raise RuntimeError("Gemini Live interrupted the recording")
                for chunk in chunks_from_message(data):
                    received.extend(chunk)
                    if len(received) > args.max_seconds * RATE * 2:
                        raise RuntimeError("Output exceeded maximum duration")
                if sc.get("turnComplete"):
                    complete = True
                    break
    if not ready:
        raise RuntimeError("Never received Gemini Live setupComplete")
    if not complete:
        raise RuntimeError("Gemini Live ended without a turnComplete signal")
    if len(received) == 0 or len(received) % 2:
        raise RuntimeError("No valid 16-bit PCM audio received")
    seconds = len(received) / (RATE * 2)
    if seconds < args.min_seconds:
        raise RuntimeError(f"Complete model turn is too short ({seconds:.2f}s)")
    return bytes(received), seconds


def save_complete_wav(pcm, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=".unfinished-", suffix=".wav", dir=path.parent, delete=False
        ) as fp:
            tmp = Path(fp.name)
            with wave.open(fp, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(RATE)
                wav.writeframes(pcm)
        tmp.replace(path)
    finally:
        if tmp and tmp.exists():
            tmp.unlink()


async def main():
    args = options()
    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        raise SystemExit("GEMINI_API_KEY not set in GitHub Actions secrets")
    if not (0 < args.min_seconds <= args.max_seconds <= 300):
        raise SystemExit("Invalid minimum/maximum duration")
    if not (1 <= args.attempts <= 3):
        raise SystemExit("Attempts must be between 1 and 3")
    for n in range(1, args.attempts + 1):
        print(f"Direct Gemini Live WebSocket attempt {n}/{args.attempts} model={args.model} voice={args.voice}", flush=True)
        try:
            pcm, seconds = await live_turn(args, key)
            save_complete_wav(pcm, Path(args.output))
            print(f"COMPLETE WAV saved: {args.output} ({seconds:.2f}s)", flush=True)
            return
        except Exception as exc:
            message = str(exc).replace(key, "[REDACTED]")
            print(f"Attempt {n} failed: {type(exc).__name__}: {message[:300]}", flush=True)
    raise SystemExit("No complete WAV was produced; no artifact will be uploaded.")


if __name__ == "__main__":
    asyncio.run(main())
