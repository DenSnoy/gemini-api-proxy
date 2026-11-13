"""Check Gemini model-list access without exposing the API key in logs."""
import json
import os
import sys
import urllib.error
import urllib.request

key = os.environ.get("GEMINI_API_KEY")
if not key:
    sys.exit("GEMINI_API_KEY secret is not configured")
url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"
req = urllib.request.Request(url, headers={"x-goog-api-key": key}, method="GET")
try:
    with urllib.request.urlopen(req, timeout=20) as response:
        result = json.load(response)
        print(f"Gemini REST API model listing: HTTP {response.status}", flush=True)
except urllib.error.HTTPError as error:
    print(f"Gemini REST API model listing: HTTP {error.code}", flush=True)
    try:
        info = json.loads(error.read(16384)).get("error", {})
        print("Google error status:", info.get("status", "unknown"), flush=True)
        print("Google error message:", str(info.get("message", ""))[:250].replace(key, "[REDACTED]"), flush=True)
        reasons = [d.get("reason") for d in info.get("details", []) if isinstance(d, dict) and d.get("reason")]
        if reasons:
            print("Google error reasons:", ", ".join(reasons), flush=True)
        if error.code == 401:
            print("401 does NOT imply that the key must start with AIza: modern AI Studio auth keys often start with AQ.", flush=True)
            print("Check for an AQ auth-key provisioning issue or incorrect secret value; no OAuth or Google Cloud SDK is required for Gemini Developer API auth keys.", flush=True)
    except Exception:
        pass
    sys.exit(1)
except Exception as error:
    sys.exit(f"Cannot reach the Gemini REST API: {type(error).__name__}")

models = result.get("models", [])
live_models = sorted(m.get("name", "") for m in models if "live" in m.get("name", "").lower() or "native-audio" in m.get("name", "").lower())
print(f"Models visible to this API key: {len(models)}", flush=True)
print("Live or native-audio model names:", ", ".join(live_models) if live_models else "(none in list response)", flush=True)
