"""Diagnose Gemini API authorization without revealing credential values.

Official Gemini API key methods: x-goog-api-key, or ?key=.
Does not use OAuth, does not log or print secret content.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

key = os.environ.get("GEMINI_API_KEY", "")
if not key:
    sys.exit("GEMINI_API_KEY missing from GitHub Actions secrets")

print("Key exists in GitHub secret: yes")
print("Key type:", "authorization (AQ)" if key.startswith("AQ.") else "standard (AIza)" if key.startswith("AIza") else "other / unexpectedly formatted")
print("Leading/trailing whitespace:", "yes" if key != key.strip() else "no")
print("Surrounding quotes:", "yes" if key[:1] in ("'", '"') or key[-1:] in ("'", '"') else "no")
print("Embedded line breaks:", "yes" if "\n" in key or "\r" in key else "no")
print("GOOGLE_API_KEY also present:", "yes" if bool(os.environ.get("GOOGLE_API_KEY")) else "no")
print("Vertex AI explicitly enabled:", "yes" if os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "").lower() in ("1", "true", "yes") else "no")

base = "https://generativelanguage.googleapis.com"
def probe(path, use_query):
    url = base + path
    headers = {"Accept": "application/json"}
    if use_query:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode({"key": key})
    else:
        headers["x-goog-api-key"] = key
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = json.load(r)
            print(f"Probe {path}, auth={'query' if use_query else 'header'}: HTTP {r.status}")
            models = body.get("models", [])
            live = [m.get("name") for m in models if ("live" in m.get("name", "").lower() or "native-audio" in m.get("name", "").lower())]
            if live:
                print("Visible Live models:", ", ".join(live))
            return True
    except urllib.error.HTTPError as e:
        status = "unknown"
        reasons = []
        try:
            info = json.loads(e.read(16384)).get("error", {})
            status = info.get("status", "unknown")
            reasons = [d["reason"] for d in info.get("details", []) if isinstance(d, dict) and d.get("reason")]
        except Exception:
            pass
        print(f"Probe {path}, auth={'query' if use_query else 'header'}: HTTP {e.code}, status={status}, reasons={','.join(reasons) or 'unspecified'}")
        return False
    except Exception as e:
        print(f"Probe {path}, auth={'query' if use_query else 'header'}: transport error {type(e).__name__}")
        return False

results = [
    probe("/v1beta/models?pageSize=5", False),
    probe("/v1beta/models?pageSize=5", True),
    probe("/v1/models?pageSize=5", False),
    probe("/v1/models?pageSize=5", True),
]
if not any(results):
    sys.exit("No Gemini API authentication method succeeded. Live API request skipped.")
print("At least one official Gemini API authentication method succeeded.")
