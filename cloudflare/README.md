# Gemini text through Cloudflare Workers (existing Gemini MCP)

Worker: `gemini-chatgpt-mcp` on `densnoyroblox.workers.dev`. The original MCP voice tools and their secret bindings stay unchanged; **new speech generation still uses GitHub Actions**.

## Fast ChatGPT MCP route (no new connection)

Call the existing connected `ask_gemini({question})` tool with the special JSON envelope:

```text
@@GEMINI_EDGE_V1@@
{"mode":"flash_lite","prompt":"Скажи привет"}
```

- `flash_lite`: `gemini-flash-lite-latest`, Lite-only backups
- `flash`: `gemini-flash-latest`, Flash-only backups
- `hydrogen`: `gemini-4-hydrogen`; MUST pass `"allow_paid_hydrogen":true` after user approves potentially paid use; never automatic fallback
- `decision`: `gemini-decision-1` via its special Decisions API. Pass `input`, `questions` with `noul`, `choice` or `score` types.

Response is a tool text block containing JSON with `answer`/ `answers`, resolved model, and `elapsed_ms`. The existing unmarked `ask_gemini` calls continue to work unchanged.

## Direct HTTP API

Protected by `Authorization: Bearer <MCP_ACCESS_TOKEN>` (an existing Cloudflare secret). **Never put the token in GitHub, prompts, or client-side apps.**

- `POST https://gemini-chatgpt-mcp.densnoyroblox.workers.dev/v1/text` accepts the same JSON with `mode`, `prompt`, optional `max_output_tokens`, `model`, `exact_model`, or `stream:true`. Streaming uses Google SSE through Cloudflare.
- `POST https://gemini-chatgpt-mcp.densnoyroblox.workers.dev/v1/decision` accepts `input` and `questions` for native JSON probabilities.

Internal Cloudflare KV stores a six-hour working model backup for Flash/Lite when the main alias becomes unavailable. No metadata GET on a successful request. Never move a request into a different model family, or silently use Hydrogen.

## Runtime and source

Source for added routes: `cloudflare/gemini-text-addon.js`. This source is injected into the existing Worker module, preserving its original MIME multipart module and `GEMINI_API_KEY`, `MCP_ACCESS_TOKEN` and `AUDIO_KV` bindings (strict inheritance). Do **not** deploy this addon as a standalone Worker without supplying those bindings and surrounding legacy MCP module.

Prior known-good Worker version for rollback: `d28da31e-c255-4e04-87fa-4bb0e54f4d34` (retain until successful validation).

## Existing GitHub systems

- Live audio: `.github/workflows/gemini-live-fast.yml`, `github-live/fast-requests/*.json`.
- Text and Decision GitHub workflows remain as **backup paths**.
- After **delivering user-visible Gemini results**, the assistant (not the Worker) triggers `github-live/model-refresh-requests/<unique>.json` in GitHub and updates `github-live/model-catalog.json` only if Google metadata changed, before the turn ends.

Only Cloudflare network overhead is eliminated; model-generation time at Google is not changed.
