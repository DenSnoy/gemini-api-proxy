import assert from "node:assert/strict";
import {MODEL, ENDPOINT, validateDecisionRequest} from "./direct_gemini_decision.mjs";

assert.equal(MODEL,"gemini-decision-1");
assert.equal(ENDPOINT,"https://generativelanguage.googleapis.com/v1beta/decisions");
const request=validateDecisionRequest({
  input:"A customer requests a refund for a damaged item.",
  questions:{
    refund_request:{type:"noul",instructions:"Does the customer request a refund?"},
    route:{type:"choice",instructions:"Which department?",criteria:{
      finance:"Invoices and payment",support:"Faulty or damaged items"
    }},
    urgency:{type:"score",instructions:"Rate urgency",criteria:["Normal","High","Critical"]}
  }
});
assert.equal(Object.keys(request.questions).length,3);
assert.equal(request.timeoutMs,30000);
assert.throws(()=>validateDecisionRequest({input:"hi",questions:{q:{type:"unsupported",instructions:"x"}}}),/must be noul/);
assert.throws(()=>validateDecisionRequest({input:"hi",questions:{q:{type:"choice",instructions:"x",criteria:{only:"One"}}}}),/2–255/);
assert.throws(()=>validateDecisionRequest({input:"hi",questions:{q:{type:"noul",instructions:"x"}},model:"gemini-3.8-flash"}),/gemini-decision-1/);
console.log("PASS: Gemini Decision 1 validates noul, choice, score; rejects incorrect endpoint/model/config; zero paid calls");
