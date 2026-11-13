"""Fast offline checks for the Gemini Live PCM-to-WAV path (no API key needed)."""

import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace

from generate_live_audio import get_audio, is_idle, write_wav_atomically


def server_message(*chunks, mime="audio/pcm;rate=24000"):
    return SimpleNamespace(
        server_content=SimpleNamespace(
            model_turn=SimpleNamespace(
                parts=[
                    SimpleNamespace(inline_data=SimpleNamespace(data=chunk, mime_type=mime))
                    for chunk in chunks
                ]
            ),
        )
    )


class LiveRecorderTests(unittest.TestCase):
    def test_all_pcm_parts_are_collected(self):
        self.assertEqual(get_audio(server_message(b"\x01\x00", b"\x02\x00")), [b"\x01\x00", b"\x02\x00"])

    def test_wrong_pcm_sample_rate_is_rejected(self):
        with self.assertRaises(RuntimeError):
            get_audio(server_message(b"\x01\x00", mime="audio/pcm;rate=16000"))

    def test_interaction_idle_detection(self):
        self.assertTrue(is_idle(SimpleNamespace(interaction_status="IDLE")))
        self.assertFalse(is_idle(SimpleNamespace(interaction_status="IN_PROGRESS")))
        self.assertIsNone(is_idle(SimpleNamespace(interaction_status=None)))

    def test_wav_header_and_data(self):
        pcm = b"\x00\x00" * 24000
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "complete.wav"
            write_wav_atomically(pcm, path)
            with wave.open(str(path), "rb") as audio:
                self.assertEqual(audio.getnchannels(), 1)
                self.assertEqual(audio.getsampwidth(), 2)
                self.assertEqual(audio.getframerate(), 24000)
                self.assertEqual(audio.getnframes(), 24000)
                self.assertEqual(audio.readframes(24000), pcm)


if __name__ == "__main__":
    unittest.main()
