#!/usr/bin/env python3
"""Record a COMPLETE Gemini Live turn to a WAV file (not Gemini TTS)."""

import argparse
import asyncio
import base64
import os
import tempfile
import wave
from pathlib import Path

from google import genai

SAMPLE_RATE = 24_000
SAMPLE_WIDTH = 2  # 16-bit little-endian PCM
CHANNELS = 1
DEFAULT_PROMPT = (
    "Sing Jingle Bells in English for approximately 30 seconds, using the "
    "recognizable traditional melody, steady bouncy tempo and clear musical notes. "
    "Use a sweet, cheerful, high-pitched anime-style voice. Repeat the chorus if "
    "needed to reach the full duration. This must be actual melodic SINGING, "
    "not speaking or rhythmic recitation. Do not introduce the song."
)


def args_from_cli():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--voice", default="Leda")
    parser.add_argument("--model", default="gemini-3.8-live")
    parser.add_argument("--min-seconds", type=float, default=25.0)
    parser.add_argument("--max-seconds", type=float, default=45.0)
    parser.add_argument("--timeout-seconds", type=float, default=120.0)
    parser.add_argument("--attempts", type=int, default=2)
    parser.add_argument("--output", default="output/gemini-live.wav")
    return parser.parse_args()


def get_audio(message):
    """Collect every PCM audio part, not just the first part of an event."""
    content = getattr(message, "server_content", None)
    turn = getattr(content, "model_turn", None)
    if not turn:
        return []
    chunks = []
    for part in getattr(turn, "parts", None) or []:
        payload = getattr(part, "inline_data", None)
        if not payload or payload.data is None:
            continue
        mime = (getattr(payload, "mime_type", "") or "").lower()
        if not mime.startswith("audio/pcm"):
            raise RuntimeError(f"Unexpected Live audio format: {mime!r}")
        if "rate=" in mime and "rate=24000" not in mime:
            raise RuntimeError(f"Unexpected Live PCM sample rate: {mime!r}")
        data = payload.data
        if isinstance(data, str):
            data = base64.b64decode(data)
        chunks.append(data)
    return chunks


def is_idle(content):
    status = getattr(content, "interaction_status", None)
    if status is None:
        return None
    name = str(getattr(status, "value", status)).upper()
    if name.endswith("IDLE"):
        return True
    if name.endswith("IN_PROGRESS"):
        return False
    return None


async def record_once(client, opts):
    buffer = bytearray()
    complete = False
    config = {
        "response_modalities": ["AUDIO"],
        "speech_config": {
            "voice_config": {"prebuilt_voice_config": {"voice_name": opts.voice}}
        },
        "system_instruction": {
            "parts": [{"text": "You are an expressive musical performer. If asked to sing, "
                                "sing using actual changing pitches and rhythm; never merely read lyrics."}]
        },
    }
    async with client.aio.live.connect(model=opts.model, config=config) as session:
        await session.send_client_content(
            turns={"role": "user", "parts": [{"text": opts.prompt}]},
            turn_complete=True,
        )
        async with asyncio.timeout(opts.timeout_seconds):
            async for message in session.receive():
                content = getattr(message, "server_content", None)
                if content is None:
                    continue
                if getattr(content, "interrupted", False):
                    raise RuntimeError("Gemini Live interrupted generation")
                for chunk in get_audio(message):
                    buffer.extend(chunk)
                    if len(buffer) > opts.max_seconds * SAMPLE_RATE * SAMPLE_WIDTH:
                        raise RuntimeError("Live audio exceeded the configured maximum duration")
                idle = is_idle(content)
                if idle is True or (getattr(content, "turn_complete", False) and idle is not False):
                    complete = True
                    break

    if not complete:
        raise RuntimeError("The Live session ended before confirming completion")
    if not buffer or len(buffer) % SAMPLE_WIDTH:
        raise RuntimeError("No valid complete 16-bit PCM audio was received")
    duration = len(buffer) / (SAMPLE_RATE * SAMPLE_WIDTH)
    if duration < opts.min_seconds:
        raise RuntimeError(f"Live turn finished after {duration:.1f}s (minimum: {opts.min_seconds:.1f}s)")
    return bytes(buffer), duration


def write_wav_atomically(data, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".pending-", suffix=".wav", dir=destination.parent, delete=False) as tmp:
            tmp_path = Path(tmp.name)
            with wave.open(tmp, "wb") as wav:
                wav.setnchannels(CHANNELS)
                wav.setsampwidth(SAMPLE_WIDTH)
                wav.setframerate(SAMPLE_RATE)
                wav.writeframes(data)
        tmp_path.replace(destination)
    finally:
        if tmp_path is not None and tmp_path.exists():
            tmp_path.unlink()


async def main():
    opts = args_from_cli()
    if not os.environ.get("GEMINI_API_KEY"):
        raise SystemExit("Missing GEMINI_API_KEY (add it in GitHub Actions secrets)")
    if not (0 < opts.min_seconds <= opts.max_seconds <= 300):
        raise SystemExit("Require 0 < min-seconds <= max-seconds <= 300")
    if not (1 <= opts.attempts <= 3):
        raise SystemExit("attempts must be between 1 and 3")

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    try:
        for attempt in range(1, opts.attempts + 1):
            print(f"Gemini Live attempt {attempt}/{opts.attempts} (model={opts.model}, voice={opts.voice})", flush=True)
            try:
                data, duration = await record_once(client, opts)
                write_wav_atomically(data, Path(opts.output))
                print(f"COMPLETE WAV: {opts.output} ({duration:.2f}s, 24 kHz mono PCM)", flush=True)
                return
            except (Exception, asyncio.CancelledError) as exc:
                print(f"Attempt {attempt} failed: {type(exc).__name__}: {exc}", flush=True)
                if attempt == opts.attempts:
                    raise SystemExit("No complete recording; nothing will be uploaded.") from exc
    finally:
        client.close()


if __name__ == "__main__":
    asyncio.run(main())
