// Shared fast Gemini model routing: latest first (where verified), safe same-family fallbacks,
// metadata lookup only after model failure, and persistent working-model cache in GitHub.
import fs from "node:fs";
import {fileURLToPath} from "node:url";

export const MODEL_FAMILIES = Object.freeze({
  flash: ["gemini-flash-latest", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-flash"],
  flash_lite: ["gemini-flash-lite-latest", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"],
  live: ["gemini-3.8-live", "gemini-3.1-flash-live-preview"]
});
const CACHE_FILE = fileURLToPath(new URL("./model-fallbacks.json", import.meta.url));
const COOLDOWN_MS = 6 * 3600 * 1000;

function readCache() {
  try {
    const value = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    return value && typeof value === "object" && value.families ? value : {schema_version:1, families:{}};
  } catch {
    return {schema_version:1, families:{}};
  }
}
function isValidFamilyModel(family, name) {
  if (typeof name !== "string") return false;
  return MODEL_FAMILIES[family].includes(name);
}
function codeOf(error) {
  const code = Number(error?.status ?? error?.httpStatus);
  if (Number.isFinite(code) && code > 0) return code;
  const match = String(error?.message || "").match(/(?:HTTP\s*|code\s*)([45]\d{2})/i);
  return match ? Number(match[1]) : 0;
}
function canTryAnotherModel(error) {
  const code = codeOf(error);
  if ([401,403,422].includes(code)) return false; // bad key, billing or permissions
  if (code === 400) {
    // Only a model-related 400 warrants fallback; never retry an invalid user prompt.
    return /model.*not found|model.*not supported|unsupported model|not available|not found for api|bidi.*not supported/i.test(String(error?.message||""));
  }
  if ([404,429,500,502,503,504].includes(code)) return true;
  const s = String(error?.message || "").toLowerCase();
  if (/invalid api key|permission denied|billing|safety|blocked|policy|prompt|no audio|too short|too long|timed out|timeout/i.test(s)) return false;
  return /model.*not found|model.*not supported|not found for api|model.*unavailable|websocket transport failed|close code 1006|unexpected close|overloaded|resource.exhausted/i.test(s);
}

async function listModelsOnFailure(key) {
  // Metadata request only, never a diagnostic generateContent call.
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
      headers: {"x-goog-api-key":key},
      signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) return null;
    const data = await response.json();
    const entries = Array.isArray(data.models) ? data.models : [];
    const models = new Map();
    for (const m of entries) {
      const name = String(m?.name || "").replace(/^models\//, "");
      if (name) models.set(name, m);
    }
    return models;
  } catch {
    return null;
  }
}

async function persistWorkingFallback(family, model, previous, discovered = []) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo || "")) {
    console.log("Fallback cache not persisted: no GitHub write token");
    return;
  }
  const filePath = "github-live/model-fallbacks.json";
  const endpoint = "https://api.github.com/repos/" + repo + "/contents/" + filePath;
  const headers = {
    "Authorization":"Bearer " + token,
    "Accept":"application/vnd.github+json",
    "X-GitHub-Api-Version":"2022-11-28"
  };
  try {
    // Only on fallback: GitHub API read + write. Normal successful requests do neither.
    const current = await fetch(endpoint, {headers, signal:AbortSignal.timeout(6000)});
    if (!current.ok) throw Error("GitHub state GET HTTP " + current.status);
    const file = await current.json();
    const state = JSON.parse(Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8"));
    if (!state.families) state.families = {};
    const old = state.families[family] || {};
    state.families[family] = {
      ...old,
      preferred: model,
      alias_retry_after: new Date(Date.now() + COOLDOWN_MS).toISOString(),
      last_working_at: new Date().toISOString(),
      last_failed_model: previous,
      discovered_available: [...new Set([...((old.discovered_available || []).filter(n=>isValidFamilyModel(family,n))), ...discovered.filter(n=>isValidFamilyModel(family,n))])]
    };
    const serialized = JSON.stringify(state, null, 2) + "\n";
    const result = await fetch(endpoint, {
      method:"PUT",
      headers:{...headers, "Content-Type":"application/json"},
      body:JSON.stringify({
        message:"Cache working Gemini " + family + " fallback: " + model,
        content:Buffer.from(serialized).toString("base64"),
        sha:file.sha,
        branch:"main"
      }),
      signal:AbortSignal.timeout(6000)
    });
    if (!result.ok) throw Error("GitHub state PUT HTTP " + result.status);
    console.log("Persisted working", family, "fallback for future calls:", model);
  } catch (error) {
    // Never discard a generated user result because caching failed.
    console.log("Fallback cache save skipped:", String(error?.message||error).slice(0,140));
  }
}

export async function runWithFallback({family, apiKey, run, explicitModel = null}) {
  const defaults = MODEL_FAMILIES[family];
  if (!defaults || typeof run !== "function") throw Error("Unsupported model family: " + family);
  if (explicitModel !== null && !isValidFamilyModel(family, explicitModel)) {
    throw Error("Explicit model is not approved for this family: " + explicitModel);
  }
  const cached = readCache().families?.[family] || {};
  const cachedPreferred = isValidFamilyModel(family, cached.preferred) ? cached.preferred : null;
  const inCooldown = cachedPreferred && cached.alias_retry_after &&
    Date.parse(cached.alias_retry_after) > Date.now();
  // Recheck -latest after a 6h cooldown; no model-catalog calls on successful normal path.
  const preferred = explicitModel || (inCooldown ? cachedPreferred : defaults[0]);
  let order = [preferred, ...defaults.filter(m => m !== preferred)];
  let catalog = null;
  let lastError = null;
  let failureModel = null;
  let discovered = [];
  for (let index = 0; index < order.length; index++) {
    const model = order[index];
    try {
      console.log("Gemini", family, "attempt", index+1+"/"+order.length, "model", model);
      const value = await run(model);
      if (index > 0 || (cachedPreferred && model !== cachedPreferred)) {
        await persistWorkingFallback(family, model, failureModel || order[0], discovered);
      }
      return {model, value, usedFallback:index > 0};
    } catch (e) {
      lastError = e;
      if (!canTryAnotherModel(e)) throw e;
      failureModel ||= model;
      console.log("Gemini", family, "model unavailable; checking next family fallback:", model);
      if (catalog === null) {
        catalog = await listModelsOnFailure(apiKey) || new Map();
        discovered = defaults.filter(n => catalog.has(n));
        if (catalog.size > 0) {
          // Only models in the documented family and catalog. Do not jump into paid/other families.
          order = [...order.slice(0,index+1), ...order.slice(index+1).filter(n=>catalog.has(n))];
        }
        console.log("Model metadata matches for", family, discovered.join(", ") || "unavailable");
      }
    }
  }
  throw lastError || Error("No working Gemini model in family " + family);
}
