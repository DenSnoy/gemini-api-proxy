#!/usr/bin/env node
// Direct Gemini Flash / Flash-Lite text API on GitHub Actions.
// No npm/SDK installs; latest alias first, same-family model fallback only after errors.
import fs from "node:fs";
import path from "node:path";
import {MODEL_FAMILIES, runWithFallback} from "./model-router.mjs";

function readRequest(file) {
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!r || typeof r !== "object" || Array.isArray(r)) throw Error("Request must be JSON object");
  const mode = r.mode ?? r.family ?? "flash";
  if (!(mode === "flash" || mode === "flash_lite" || mode === "hydrogen")) throw Error("Text mode must be flash, flash_lite or hydrogen");
  if (mode === "hydrogen" && r.allow_paid_hydrogen !== true) throw Error("Hydrogen requires explicit allow_paid_hydrogen:true; never selected automatically");
  if (typeof r.prompt !== "string" || !r.prompt.trim() || r.prompt.length > 200000) {
    throw Error("Prompt must be non-empty text under 200000 characters");
  }
  const tokens = r.max_output_tokens == null ? (mode === "flash_lite" ? 1024 : 2048) : Number(r.max_output_tokens);
  const timeoutMs = r.timeout_ms == null ? 60000 : Number(r.timeout_ms);
  if (!Number.isInteger(tokens) || tokens < 64 || tokens > 8192) throw Error("Invalid max_output_tokens");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 5000 || timeoutMs > 120000) throw Error("Invalid timeout_ms");
  const explicitModel = r.model ?? null;
  if (explicitModel !== null && !MODEL_FAMILIES[mode].includes(explicitModel)) {
    throw Error("Requested model is not an approved model for " + mode);
  }
  const exactModel = r.exact_model === true;
  if (exactModel && explicitModel === null) throw Error("exact_model requires model");
  return {mode, prompt:r.prompt, tokens, timeoutMs, explicitModel, exactModel};
}

function extractText(json) {
  return (json?.candidates?.[0]?.content?.parts ?? [])
    .filter(p => typeof p.text === "string").map(p => p.text).join("\n").trim();
}

async function generate(req, apiKey, model) {
  if (!MODEL_FAMILIES[req.mode].includes(model)) throw Error("Wrong text model family");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) + ":generateContent";
  const config = {maxOutputTokens:req.tokens};
  if (model === "gemini-2.5-flash") {
    config.thinkingConfig = {thinkingBudget:0};
  } else if (req.mode === "hydrogen") {
    config.thinkingConfig = {thinkingLevel:"low"};
  } else if (req.mode === "flash" && /^gemini-3\.(8|7|6|5)-flash$/.test(model)) {
    config.thinkingConfig = {thinkingLevel:"low"};
  }
  // Do not send a version-specific thinkingConfig to a moving -latest alias.
  const payload = {
    contents:[{role:"user",parts:[{text:req.prompt}]}],
    generationConfig:config
  };
  const started = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method:"POST",
      headers:{"Content-Type":"application/json","x-goog-api-key":apiKey},
      body:JSON.stringify(payload),
      signal:AbortSignal.timeout(req.timeoutMs)
    });
  } catch(e) {throw Error("Gemini network error: " + (e?.name || "request failed"));}
  const raw = await response.text();
  let json;
  try {json = JSON.parse(raw);} catch {throw Error("Gemini non-JSON, HTTP " + response.status);}
  if (!response.ok) {
    const msg = String(json?.error?.message || "Request failed").slice(0, 240);
    const e = new Error("Gemini HTTP " + response.status + " " +
      String(json?.error?.status || "API_ERROR") + ": " + msg);
    e.status = response.status;
    throw e;
  }
  const text = extractText(json);
  if (!text) throw Error("Gemini returned no text, finishReason=" +
    String(json?.candidates?.[0]?.finishReason || "none"));
  return {text, usage:json?.usageMetadata || {}, finishReason:json?.candidates?.[0]?.finishReason || null, elapsed:Date.now()-started};
}

async function main() {
  const requestFile = process.argv[2];
  const outputFile = process.argv[3] || "output/gemini-text.txt";
  if (!requestFile) throw Error("Usage: node github-live/direct_gemini_text.mjs REQUEST.json [OUTPUT.txt]");
  const req = readRequest(requestFile);
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Error("Missing GitHub secret GEMINI_API_KEY");
  console.log("Fast Gemini text family:", req.mode, "Node:", process.version, "install: none");
  const {model, value, usedFallback} = req.exactModel
    ? {model:req.explicitModel, value:await generate(req,key,req.explicitModel), usedFallback:false}
    : await runWithFallback({
        family:req.mode,
        apiKey:key,
        explicitModel:req.explicitModel,
        run:model=>generate(req,key,model)
      });
  fs.mkdirSync(path.dirname(outputFile), {recursive:true});
  fs.writeFileSync(outputFile + ".tmp", value.text + "\n", "utf8");
  fs.renameSync(outputFile + ".tmp", outputFile);
  fs.writeFileSync(outputFile + ".json", JSON.stringify({
    mode:req.mode,
    model,
    used_fallback:usedFallback,
    generation_duration_ms:value.elapsed,
    input_tokens:value.usage.promptTokenCount ?? null,
    output_tokens:value.usage.candidatesTokenCount ?? null,
    finish_reason:value.finishReason,
    output_file:path.basename(outputFile)
  }, null, 2) + "\n");
  console.log("Gemini text complete:", model, "bytes", Buffer.byteLength(value.text));
}
main().catch(e=>{console.error(String(e?.message||e)); process.exitCode=1;});
