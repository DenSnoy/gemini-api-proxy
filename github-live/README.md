# Gemini Live audio directly in GitHub Actions (no Cloudflare)

This folder is a self-contained **Gemini Live API** (native audio, WebSocket) recorder. It is **not** Gemini Text-to-Speech (TTS). No Cloudflare Worker is used in this recording workflow.

The job sends your text instruction to Gemini Live, receives all PCM audio chunks, waits for the **complete model turn**, checks the total duration, then packages the result as a 24 kHz / mono / 16-bit WAV file. **The GitHub artifact is uploaded only after successful completion.** A connection failure, interruption, too-short response, or missing end-of-turn marker produces **no artifact**.

## Setup

1. In **GitHub → Repository Settings → Secrets and variables → Actions**, create a repository secret called `GEMINI_API_KEY`. Paste your Gemini API key there. **Never put your key in code, workflow inputs, or public files.**
2. Merge the feature branch containing this workflow into `main`. GitHub only exposes manually dispatched workflows from the default branch.
3. Open the repository's **Actions** tab → **Gemini Live — complete WAV** → **Run workflow**.
4. Choose a prompt, a voice (for example `Leda` or `Fenrir`), the Live model ID, and minimum duration. Then run it.
5. When the job **succeeds**, open its run page and download the artifact **gemini-live-complete-wav**. GitHub downloads it as a ZIP containing `gemini-live.wav`.

## Default example

A cheerful high-pitched anime-style performance of *Jingle Bells* in English, approximately 30 seconds. The default minimum is 25 seconds, maximum 45 seconds, and at most **two complete attempts** are made.

> **Important:** Gemini Live is a voice/conversation model. Singing and exact song duration are not guaranteed. The recorder checks completion and duration, **not whether the content is melodically correct**. If Gemini stops early, the run fails and does not publish partial audio.

## Implementation

- Python script: `github-live/generate_live_audio.py`
- Test suite: `github-live/test_generate_live_audio.py`
- Manual GitHub Action: `.github/workflows/gemini-live-audio.yml`
- Gemini Live API model (default): `gemini-3.8-live` (change the workflow input if another available Live model is needed).
- Audio received from Gemini: raw PCM 16-bit mono at 24 kHz; `wave` from the Python standard library converts it to WAV.
- Authentication: `GEMINI_API_KEY` GitHub Actions secret.
- Artifact retention: 7 days.

This batch-recording design **does not stream playback to the browser**. It waits until the whole WAV is ready. GitHub Actions queue/startup time may add delay; using GitHub Actions alone does not automatically speed up Gemini's speech generation. Gemini API use may incur charges depending on the account's limits and billing.

The legacy Cloudflare proxy files in the repository are not used by the new workflow and can be left untouched.

Reference: [Official Gemini Live API guide](https://ai.google.dev/gemini-api/docs/live-api/get-started-sdk).
