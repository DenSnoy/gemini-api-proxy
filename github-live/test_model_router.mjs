import assert from "node:assert/strict";
import {MODEL_FAMILIES, runWithFallback} from "./model-router.mjs";

const originalFetch = globalThis.fetch;
const originalToken = process.env.GITHUB_TOKEN;
delete process.env.GITHUB_TOKEN;
const catalog = {
  models:Object.values(MODEL_FAMILIES).flat().map(name=>({name:"models/"+name}))
};
let metadataCalls = 0;
globalThis.fetch = async () => {
  metadataCalls++;
  return {ok:true, json:async()=>catalog};
};
try {
  let calls = [];
  const fast = await runWithFallback({
    family:"flash",
    apiKey:"not-a-key",
    explicitModel:"gemini-flash-latest",
    run:async model=>{
      calls.push(model);
      if (model==="gemini-flash-latest") {
        const e = Error("Model not found for API version");e.status=404;throw e;
      }
      return "success";
    }
  });
  assert.equal(fast.model,"gemini-3.8-flash");
  assert.equal(fast.value,"success");
  assert.equal(metadataCalls,1);
  assert.deepEqual(calls,["gemini-flash-latest","gemini-3.8-flash"]);

  calls = [];
  const lite = await runWithFallback({
    family:"flash_lite",
    apiKey:"not-a-key",
    explicitModel:"gemini-flash-lite-latest",
    run:async model=>{calls.push(model);return "lite ok";}
  });
  assert.equal(lite.model,"gemini-flash-lite-latest");
  assert.equal(metadataCalls,1,"no metadata GET on success");

  calls = [];
  const live = await runWithFallback({
    family:"live",
    apiKey:"not-a-key",
    explicitModel:"gemini-3.8-live",
    run:async model=>{
      calls.push(model);
      if (model==="gemini-3.8-live") throw Error("Gemini WebSocket transport failed");
      return "audio complete";
    }
  });
  assert.equal(live.model,"gemini-3.1-flash-live-preview");
  assert.equal(live.value,"audio complete");
  assert.deepEqual(calls,["gemini-3.8-live","gemini-3.1-flash-live-preview"]);

  calls=[];
  await assert.rejects(
    runWithFallback({
      family:"flash",apiKey:"not-a-key",explicitModel:"gemini-flash-latest",
      run:async model=>{calls.push(model); const e=Error("HTTP 401 INVALID_API_KEY");e.status=401;throw e;}
    }),
    /INVALID_API_KEY/
  );
  assert.deepEqual(calls,["gemini-flash-latest"],"do not retry for auth errors");

  await assert.rejects(
    runWithFallback({family:"flash",apiKey:"x",explicitModel:"gemini-3.8-live",run:async()=>""}),
    /not approved/
  );
  console.log("PASS: latest first; same-family fallback; metadata only on failure; no auth retries; no family crossing");
} finally {
  globalThis.fetch=originalFetch;
  if (originalToken !== undefined) process.env.GITHUB_TOKEN=originalToken;
}
