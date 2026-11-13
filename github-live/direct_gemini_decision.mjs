#!/usr/bin/env node
// Gemini Decision 1 via the dedicated Decisions API, not generateContent.
// Node 22+ built-in fetch; no npm install, SDK, Python or inference probes.
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";

export const MODEL = "gemini-decision-1";
export const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/decisions";

function isObject(o) { return o !== null && typeof o === "object" && !Array.isArray(o); }
function nonempty(s) { return typeof s === "string" && !!s.trim(); }

export function validateDecisionRequest(obj) {
  if (!isObject(obj)) throw Error("Decision request must be a JSON object");
  if (obj.model !== undefined && obj.model !== MODEL) throw Error("Decision mode requires gemini-decision-1");
  if (obj.input === undefined || obj.input === null ||
      !(nonempty(obj.input) || Array.isArray(obj.input))) throw Error("Provide an input string or content array");
  if (Array.isArray(obj.input)) {
    if (obj.input.length < 1 || obj.input.length > 24) throw Error("Input array must contain 1–24 items");
    for (const content of obj.input) {
      if (!isObject(content) || !["text","image","audio","video","file"].includes(content.type)) {
        throw Error("Input content requires a recognized type");
      }
      if (content.type === "text" && !nonempty(content.text)) throw Error("Text content must be nonempty");
      if (content.type !== "text" && !nonempty(content.uri) && !nonempty(content.data)) {
        throw Error("Media content requires uri or data");
      }
    }
  }
  if (!isObject(obj.questions)) throw Error("Provide named decision questions");
  const questions=Object.entries(obj.questions);
  if (questions.length<1 || questions.length>1000) throw Error("Use between 1 and 1000 questions");
  for (const [name,q] of questions) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(name)) throw Error("Invalid question name: " + name);
    if (!isObject(q) || !nonempty(q.instructions)) throw Error("Question " + name + " needs instructions");
    if (q.type === "noul") continue;
    if (q.type === "choice") {
      if (!isObject(q.criteria) || Object.keys(q.criteria).length<2 ||
          Object.keys(q.criteria).length>255 ||
          Object.values(q.criteria).some(value=>!nonempty(value))) {
        throw Error("Choice question " + name + " needs 2–255 described options");
      }
      continue;
    }
    if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length<2 || q.criteria.length>255 ||
          q.criteria.some(value=>!nonempty(value))) {
        throw Error("Score question " + name + " needs 2–255 ordered descriptions");
      }
      continue;
    }
    throw Error("Question " + name + " type must be noul, choice or score");
  }
  const timeoutMs=obj.timeout_ms===undefined?30000:Number(obj.timeout_ms);
  if(!Number.isInteger(timeoutMs) || timeoutMs<5000 || timeoutMs>120000) {
    throw Error("timeout_ms must be 5000–120000");
  }
  return {model:MODEL,input:obj.input,questions:obj.questions,timeoutMs};
}

async function main() {
  const requestFile=process.argv[2];
  const outputPath=process.argv[3] || "output/gemini-decision.json";
  if(!requestFile) throw Error("Usage: node github-live/direct_gemini_decision.mjs REQUEST.json [OUTPUT.json]");
  const {model,input,questions,timeoutMs}=validateDecisionRequest(
    JSON.parse(fs.readFileSync(requestFile,"utf8")));
  const key=process.env.GEMINI_API_KEY;
  if(!key) throw Error("Missing GEMINI_API_KEY GitHub secret");
  const started=Date.now();
  const response=await fetch(ENDPOINT,{
    method:"POST",
    headers:{"Content-Type":"application/json","x-goog-api-key":key},
    body:JSON.stringify({model,input,questions}),
    signal:AbortSignal.timeout(timeoutMs)
  });
  const raw=await response.text();
  let json;
  try {json=JSON.parse(raw);} catch{throw Error("Decision API response is not JSON, HTTP "+response.status);}
  if(!response.ok){
    throw Error("Gemini Decisions HTTP "+response.status+": "+
      String(json?.error?.message||"Request failed").slice(0,250));
  }
  if(!isObject(json.answers))throw Error("Gemini Decisions response has no answers");
  const payload={
    model, mode:"decision", elapsed_ms:Date.now()-started,
    question_count:Object.keys(questions).length,
    answers:json.answers,
    usage:json.usage || json.usageMetadata || null
  };
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});
  fs.writeFileSync(outputPath+".tmp",JSON.stringify(payload,null,2)+"\n","utf8");
  fs.renameSync(outputPath+".tmp",outputPath);
  console.log("DECISION_COMPLETE",model, "questions",payload.question_count,"elapsed_ms",payload.elapsed_ms);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(e=>{console.error(e.message);process.exitCode=1;});
}
