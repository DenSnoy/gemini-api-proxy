#!/usr/bin/env node
// Metadata-only Gemini model refresh. Triggered by the assistant in its own
// GitHub Actions run ONLY AFTER delivering generated text/audio to the user.
// No Gemini generation, no SDK installs, no pricing/free-tier inference.
import fs from "node:fs";
import path from "node:path";

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const apiKey = process.env.GEMINI_API_KEY;
const filePath = "github-live/model-catalog.json";
if (!apiKey || !token || !repo) throw Error("Missing GEMINI_API_KEY, GITHUB_TOKEN or GITHUB_REPOSITORY");

function normalize(m) {
  const id = String(m?.name || "").replace(/^models\//, "");
  if (!id || !/^[-a-zA-Z0-9_.]+$/.test(id)) return null;
  return {
    id,
    display_name: String(m.displayName || ""),
    version: String(m.version || ""),
    supported_generation_methods: [...new Set(m.supportedGenerationMethods || [])].sort(),
    input_token_limit: Number.isFinite(m.inputTokenLimit) ? m.inputTokenLimit : null,
    output_token_limit: Number.isFinite(m.outputTokenLimit) ? m.outputTokenLimit : null
  };
}
async function getModels() {
  const map = new Map();
  let pageToken = "";
  for (let page=0;page<25;page++) {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize","1000");
    if (pageToken) url.searchParams.set("pageToken",pageToken);
    const res = await fetch(url, {
      headers:{"x-goog-api-key":apiKey},
      signal:AbortSignal.timeout(16000)
    });
    if(!res.ok) throw Error("Gemini models.list HTTP " + res.status);
    const d = await res.json();
    if(!Array.isArray(d.models)) throw Error("Unexpected models.list response (missing models)");
    for (const raw of d.models) {
      const m = normalize(raw);
      if(m) map.set(m.id,m);
    }
    const next = d.nextPageToken || "";
    if(!next) return [...map.values()].sort((a,b)=>a.id.localeCompare(b.id));
    if(next === pageToken) throw Error("Repeated pageToken");
    pageToken=next;
  }
  throw Error("models.list exceeded maximum pages");
}
async function github(method,url,body) {
  const res = await fetch(url,{
    method,
    headers:{
      Authorization:"Bearer "+token,
      Accept:"application/vnd.github+json",
      "X-GitHub-Api-Version":"2022-11-28",
      ...(body?{"Content-Type":"application/json"}:{})
    },
    ...(body?{body:JSON.stringify(body)}:{}),
    signal:AbortSignal.timeout(12000)
  });
  if(!res.ok) throw Error("GitHub "+method+" HTTP "+res.status);
  return res.json();
}
async function main() {
  const currentModels=await getModels();
  const endpoint = "https://api.github.com/repos/"+repo+"/contents/"+filePath;
  const oldBlob=await github("GET",endpoint);
  const oldData=JSON.parse(Buffer.from(oldBlob.content.replace(/\s/g,""),"base64").toString("utf8"));
  const previous=Array.isArray(oldData.models)?oldData.models:[];
  const oldMap=new Map(previous.map(x=>[x.id,x]));
  const newMap=new Map(currentModels.map(x=>[x.id,x]));
  const added=currentModels.filter(x=>!oldMap.has(x.id)).map(x=>x.id);
  const removed=previous.filter(x=>!newMap.has(x.id)).map(x=>x.id);
  const changed=currentModels.filter(x=>oldMap.has(x.id)&&JSON.stringify(oldMap.get(x.id))!==JSON.stringify(x)).map(x=>x.id);
  const changedAny=added.length+removed.length+changed.length>0;
  const result={
    source:"Google Gemini API GET /v1beta/models (metadata only)",
    checked_at:new Date().toISOString(),
    models_count:currentModels.length,
    changed:changedAny,
    added, removed, modified:changed
  };
  fs.mkdirSync("output",{recursive:true});
  if(changedAny) {
    const newData={
      schema_version:1,
      source:"Gemini API models.list; visible to this API key; not proof of free-tier pricing or quota",
      last_changed_at:result.checked_at,
      models:currentModels
    };
    const body=Buffer.from(JSON.stringify(newData,null,2)+"\n").toString("base64");
    await github("PUT",endpoint,{
      message:"Refresh Gemini model metadata ("+added.length+" added, "+removed.length+" removed, "+changed.length+" changed)",
      content:body,
      sha:oldBlob.sha,
      branch:"main"
    });
    console.log("Saved model catalog changes to",filePath);
  }else{
    console.log("Catalog unchanged; no GitHub commit needed");
  }
  fs.writeFileSync("output/model-catalog-refresh.json",JSON.stringify(result,null,2)+"\n");
  console.log("MODELS_REFRESH_SUMMARY",JSON.stringify(result));
}
main().catch(e=>{console.error("Model metadata refresh failed:",e.message);process.exitCode=1;});
