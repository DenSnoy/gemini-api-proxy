#!/usr/bin/env node
// Direct Gemini Flash / Flash-Lite text API for GitHub Actions.
// Node 22+ built-in fetch; NO npm, Python, SDK or model-discovery generation probes.
import fs from "node:fs";
import path from "node:path";

const MODES = Object.freeze({
  flash: "gemini-3.8-flash",
  flash_lite: "gemini-3.5-flash-lite",
});

function readRequest(file) {
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof r !== "object" || r === null || Array.isArray(r)) {
    throw Error("Request must be a JSON object");
  }
  const mode = r.mode ?? r.family ?? "flash";
  if (!Object.hasOwn(MODES, mode)) {
    throw Error("mode must be 'flash' or 'flash_lite'; text and Live have separate workflows");
  }
  if (typeof r.prompt !== "string" || !r.prompt.trim() || r.prompt.length > 200000) {
    throw Error("Prompt must be non-empty text under 200000 characters");
  }
  const tokens = r.max_output_tokens == null ? (mode === "flash_lite" ? 1024 : 2048) : Number(r.max_output_tokens);
  if (!Number.isInteger(tokens) || tokens < 64 || tokens > 8192) {
    throw Error("max_output_tokens must be an integer between 64 and 8192");
  }
  const timeoutMs = r.timeout_ms == null ? 60000 : Number(r.timeout_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 5000 || timeoutMs > 120000) {
    throw Error("timeout_ms must be 5000–120000");
  }
  return {mode, prompt: r.prompt, model: MODES[mode], tokens, timeoutMs};
}

function extractText(json) {
  const items = json?.candidates?.[0]?.content?.parts ?? [];
  return items.filter(p => typeof p.text === "string").map(p => p.text).join("\n").trim();
}

async function main() {
  const requestFile = process.argv[2];
  const outputFile = process.argv[3] || "output/gemini-text.txt";
  if (!requestFile) throw Error("Usage: node github-live/direct_gemini_text.mjs REQUEST.json [OUTPUT.txt]");
  const req = readRequest(requestFile);
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Error("Missing GitHub secret GEMINI_API_KEY");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(req.model) + ":generateContent";
  const config = {maxOutputTokens: req.tokens};
  // Gemini 3.8 Flash supports low thinking. Flash-Lite uses model defaults.
  if (req.mode === "flash") config.thinkingConfig = {thinkingLevel: "low"};
  const payload = {
    contents: [{role: "user", parts: [{text: req.prompt}]}],
    generationConfig: config
  };
  const started = Date.now();
  console.log("Gemini text:", req.mode, "model:", req.model,
    "SDK: none, node:", process.version);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(req.timeoutMs)
    });
  } catch (e) {
    throw Error("Gemini network error: " + (e?.name || "request failed"));
  }
  const raw = await response.text();
  let parsed;
  try {parsed = JSON.parse(raw);} catch {throw Error("Gemini returned non-JSON response, HTTP " + response.status);}
  if (!response.ok) {
    const code = String(parsed?.error?.status || "API_ERROR");
    const msg = String(parsed?.error?.message || "Request failed").slice(0, 240);
    throw Error("Gemini HTTP " + response.status + " " + code + ": " + msg);
  }
  const content = extractText(parsed);
  if (!content) {
    const reason = parsed?.candidates?.[0]?.finishReason || "no text parts";
    throw Error("Gemini returned no text output (" + reason + ")");
  }
  fs.mkdirSync(path.dirname(outputFile), {recursive: true});
  const temp = outputFile + ".tmp";
  fs.writeFileSync(temp, content + "\n", "utf8");
  fs.renameSync(temp, outputFile);
  const meta = {
    mode: req.mode,
    model: req.model,
    generation_duration_ms: Date.now() - started,
    input_tokens: parsed?.usageMetadata?.promptTokenCount ?? null,
    output_tokens: parsed?.usageMetadata?.candidatesTokenCount ?? null,
    finish_reason: parsed?.candidates?.[0]?.finishReason ?? null,
    output_file: path.basename(outputFile)
  };
  fs.writeFileSync(outputFile + ".json", JSON.stringify(meta, null, 2) + "\n");
  console.log("Complete text:", meta.model, "bytes:", Buffer.byteLength(content), "elapsed_ms:", meta.generation_duration_ms);
}
main().catch(e => {console.error(e.message); process.exitCode = 1;});
