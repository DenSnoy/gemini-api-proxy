// GEMINI_FAST_EDGE_V1 — additive routes for the existing private Gemini MCP Worker.
// Source of truth: DenSnoy/gemini-api-proxy/cloudflare/gemini-text-addon.js
// Never remove or replace legacy MCP Live functionality.
const GEMINI_EDGE_MARKER = "@@GEMINI_EDGE_V1@@\n";
const GEMINI_EDGE_MODELS = Object.freeze({
  flash: ["gemini-flash-latest","gemini-3.8-flash","gemini-3.7-flash","gemini-3.6-flash","gemini-3.5-flash","gemini-2.5-flash"],
  flash_lite: ["gemini-flash-lite-latest","gemini-3.5-flash-lite","gemini-3.1-flash-lite","gemini-2.5-flash-lite"],
  hydrogen: ["gemini-4-hydrogen"]
});
const GEMINI_EDGE_HEADERS = {"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};

function geminiEdgeError(status, message) {
  const e = new Error(String(message).slice(0,350));
  e.status = status;
  return e;
}
function geminiEdgeJSON(data, status = 200) {
  return Response.json(data,{status,headers:GEMINI_EDGE_HEADERS});
}
function geminiEdgeValidate(payload, forcedMode = null) {
  if (!payload || typeof payload!=="object" || Array.isArray(payload)) throw geminiEdgeError(400,"Expected JSON object");
  const mode=forcedMode || payload.mode || "flash";
  if (!["flash","flash_lite","hydrogen","decision"].includes(mode)) throw geminiEdgeError(400,"Unsupported mode");
  if (mode==="hydrogen" && payload.allow_paid_hydrogen!==true) throw geminiEdgeError(403,"Hydrogen requires explicit paid billing consent");
  if (mode==="decision") {
    const input=payload.input;
    if (!(typeof input==="string"&&input.trim()) && !(Array.isArray(input)&&input.length>0&&input.length<=24)) throw geminiEdgeError(400,"Decision input required");
    const q=payload.questions;
    if (!q || typeof q!=="object" || Array.isArray(q)||Object.keys(q).length<1||Object.keys(q).length>1000) throw geminiEdgeError(400,"Decision questions required");
    for (const [name,spec] of Object.entries(q)) {
      if (!/^[\w-]{1,64}$/.test(name)||!spec||typeof spec.instructions!=="string"||!spec.instructions.trim()) throw geminiEdgeError(400,"Invalid decision instructions");
      if (!["noul","choice","score"].includes(spec.type)) throw geminiEdgeError(400,"Invalid decision type");
      if (spec.type==="choice" && (!spec.criteria||Array.isArray(spec.criteria)||Object.keys(spec.criteria).length<2)) throw geminiEdgeError(400,"Choice needs criteria");
      if (spec.type==="score" && (!Array.isArray(spec.criteria)||spec.criteria.length<2)) throw geminiEdgeError(400,"Score needs criteria");
    }
    return {mode,input,questions:q};
  }
  if (typeof payload.prompt!=="string"||!payload.prompt.trim()||payload.prompt.length>120000) throw geminiEdgeError(400,"Prompt required");
  const explicit=payload.model??null;
  if (explicit!==null&&!GEMINI_EDGE_MODELS[mode].includes(explicit)) throw geminiEdgeError(400,"Model belongs to another family");
  const tokens=payload.max_output_tokens===undefined?(mode==="flash_lite"?1024:2048):Number(payload.max_output_tokens);
  if (!Number.isInteger(tokens)||tokens<64||tokens>8192) throw geminiEdgeError(400,"Invalid max_output_tokens");
  return {mode,prompt:payload.prompt,explicit,tokens,exact:payload.exact_model===true,stream:payload.stream===true};
}
async function geminiEdgeGetPreferred(mode,env) {
  if(!env.AUDIO_KV)return null;
  try{
    const state=await env.AUDIO_KV.get("edge-model:v1:"+mode,{type:"json"});
    return state && state.until>Date.now() && GEMINI_EDGE_MODELS[mode].includes(state.model)?state.model:null;
  }catch{return null;}
}
async function geminiEdgeRemember(mode,model,env) {
  if(!env.AUDIO_KV)return;
  try{
    await env.AUDIO_KV.put("edge-model:v1:"+mode,JSON.stringify({model,until:Date.now()+21600000}),{expirationTtl:21600});
  }catch{} // Failing to save cache must not discard valid generation.
}
async function geminiEdgeKnownModels(env){
  try{
    const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",{
      headers:{"x-goog-api-key":env.GEMINI_API_KEY},signal:AbortSignal.timeout(4500)
    });
    if(!r.ok)return null;
    const j=await r.json();
    return new Set((j.models||[]).map(x=>String(x.name||"").replace(/^models\//,"")));
  }catch{return null;}
}
function geminiEdgeCanFallback(e) {
  const n=Number(e?.status||0);
  if ([404,429,500,502,503,504].includes(n)) return true;
  if(n===400)return /model.*(?:unsupported|not found|unavailable)|not found for api/i.test(e.message||"");
  return false;
}
async function geminiEdgeModelRequest(model,req,env) {
  const generationConfig={maxOutputTokens:req.tokens};
  if(/^gemini-3\.(8|7|6|5)-flash$/.test(model)) generationConfig.thinkingConfig={thinkingLevel:"low"};
  if(model==="gemini-2.5-flash")generationConfig.thinkingConfig={thinkingBudget:0};
  const endpoint="https://generativelanguage.googleapis.com/v1beta/models/"+encodeURIComponent(model)+
    (req.stream?":streamGenerateContent?alt=sse":":generateContent");
  const start=Date.now();
  let res;
  try{
    res=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
      body:JSON.stringify({contents:[{role:"user",parts:[{text:req.prompt}]}],generationConfig}),
      signal:AbortSignal.timeout(req.stream?110000:85000)});
  }catch(e){throw geminiEdgeError(502,"Gemini upstream connection: "+String(e?.name||"failure"));}
  if(!res.ok) {
    let message="Gemini upstream HTTP "+res.status;
    try{const e=await res.json();message+=" "+String(e.error?.message||"").slice(0,200);}catch{}
    throw geminiEdgeError(res.status,message);
  }
  if(req.stream){
    return {stream:res.body,model,elapsed_ms:Date.now()-start};
  }
  const data=await res.json();
  const answer=(data.candidates?.[0]?.content?.parts||[]).filter(x=>typeof x.text==="string").map(x=>x.text).join("\n").trim();
  if(!answer)throw geminiEdgeError(422,"Google returned no text");
  return {mode:req.mode,model,answer,elapsed_ms:Date.now()-start,usage:data.usageMetadata||null};
}
async function geminiEdgeGenerate(payload,env,ctx,forcedMode=null) {
  if(!env.GEMINI_API_KEY)throw geminiEdgeError(503,"Gemini secret missing");
  const req=geminiEdgeValidate(payload,forcedMode);
  if(req.mode==="decision"){
    const start=Date.now();
    let r;
    try {r=await fetch("https://generativelanguage.googleapis.com/v1beta/decisions",{
      method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
      body:JSON.stringify({model:"gemini-decision-1",input:req.input,questions:req.questions}),
      signal:AbortSignal.timeout(30000)
    });}catch(e){throw geminiEdgeError(502,"Decision upstream "+String(e.name||"network"));}
    const data=await r.json();
    if(!r.ok)throw geminiEdgeError(r.status,"Decision API HTTP "+r.status+": "+String(data.error?.message||"").slice(0,200));
    if(!data.answers)throw geminiEdgeError(502,"Decision API gave no answers");
    return {mode:"decision",model:"gemini-decision-1",answers:data.answers,elapsed_ms:Date.now()-start};
  }
  const defaults=GEMINI_EDGE_MODELS[req.mode];
  const preferred=req.explicit||await geminiEdgeGetPreferred(req.mode,env)||defaults[0];
  const order=req.exact?[preferred]:[preferred,...defaults.filter(x=>x!==preferred)];
  let available=null;
  let failure=null;
  for(let i=0;i<order.length;i++){
    const model=order[i];
    if(available && !available.has(model))continue;
    try{
      const response=await geminiEdgeModelRequest(model,req,env);
      if(i>0){
        const work=geminiEdgeRemember(req.mode,model,env);
        if(ctx?.waitUntil)ctx.waitUntil(work);else await work;
      }
      if(req.stream)response.fallback=i>0;
      else response.fallback=i>0;
      return response;
    }catch(e){
      failure=e;
      if(req.exact || !geminiEdgeCanFallback(e))throw e;
      if(available===null)available=await geminiEdgeKnownModels(env);
    }
  }
  throw failure||geminiEdgeError(502,"No reachable model in family");
}
async function geminiEdgeAskMCP(question,env) {
  try{
    const payload=JSON.parse(question.slice(GEMINI_EDGE_MARKER.length));
    const data=await geminiEdgeGenerate(payload,env,null);
    return textResult(JSON.stringify(data));
  }catch(e){
    return textResult(JSON.stringify({error:String(e.message||"Gemini edge error"),status:e.status||502}),true);
  }
}
async function geminiEdgeAuthorized(request,env) {
  if(typeof env.MCP_ACCESS_TOKEN!=="string"||env.MCP_ACCESS_TOKEN.length<32)return false;
  const header=request.headers.get("Authorization")||"";
  const expected="Bearer "+env.MCP_ACCESS_TOKEN;
  const enc=new TextEncoder();
  const [a,b]=await Promise.all([
    crypto.subtle.digest("SHA-256",enc.encode(header)),
    crypto.subtle.digest("SHA-256",enc.encode(expected))
  ]);
  const lhs=new Uint8Array(a),rhs=new Uint8Array(b);
  let diff=0;
  for(let i=0;i<lhs.length;i++)diff|=lhs[i]^rhs[i];
  return diff===0;
}
async function geminiEdgeHTTP(request,env,ctx,pathname) {
  if(request.method!=="POST")return new Response("Method not allowed",{status:405,headers:{Allow:"POST"}});
  if(!await geminiEdgeAuthorized(request,env))return geminiEdgeJSON({error:"Unauthorized"},401);
  const size=Number(request.headers.get("content-length")||"0");
  if(size>180000)return geminiEdgeJSON({error:"Request too large"},413);
  let body;
  try{const raw=await request.text();if(raw.length>180000)throw Error("Too large");body=JSON.parse(raw);}
  catch{return geminiEdgeJSON({error:"Invalid JSON or request too large"},400);}
  try{
    const data=await geminiEdgeGenerate(body,env,ctx,pathname.endsWith("/decision")?"decision":null);
    if(data.stream){
      return new Response(data.stream,{status:200,headers:{
        "Content-Type":"text/event-stream","Cache-Control":"no-store",
        "X-Gemini-Model":data.model,"X-Content-Type-Options":"nosniff"
      }});
    }
    return geminiEdgeJSON(data);
  }catch(e){return geminiEdgeJSON({error:String(e.message||"Upstream error").slice(0,350),status:e.status||502},e.status&&e.status>=400&&e.status<=599?e.status:502);}
}
// END GEMINI_FAST_EDGE_V1
