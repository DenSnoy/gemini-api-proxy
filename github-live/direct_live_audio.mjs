#!/usr/bin/env node
// Gemini Live to a complete PCM WAV. Node >=22 built-in WebSocket; zero npm/pip installs.
// Writes no partial audio: the WAV appears only after Google's turnComplete event.
import fs from "node:fs";
import path from "node:path";

const RATE = 24000;
const BYTES_PER_SECOND = RATE * 2;
const WS_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

function argsFromCli() {
  const args = {
    prompt: "", voice: "Leda", model: "gemini-3.8-live",
    minSeconds: 3.5, targetSeconds: 30, maxSeconds: 120,
    timeoutSeconds: 90, attempts: 2, maxTargetSeconds: null,
    output: "output/gemini-live.wav"
  };
  const raw = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i].startsWith("--") || i + 1 >= process.argv.length) {
      throw Error("Every option must be --name value");
    }
    raw[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  if (raw["request-file"]) {
    const request = JSON.parse(fs.readFileSync(raw["request-file"], "utf8"));
    for (const [from, to] of [
      ["prompt", "prompt"], ["voice", "voice"], ["model", "model"],
      ["min_seconds", "minSeconds"], ["target_seconds", "targetSeconds"],
      ["max_seconds", "maxSeconds"], ["timeout_seconds", "timeoutSeconds"],
      ["max_target_seconds", "maxTargetSeconds"]
    ]) if (request[from] !== undefined) args[to] = request[from];
  }
  for (const [from, to] of [
    ["prompt", "prompt"], ["voice", "voice"], ["model", "model"],
    ["min-seconds", "minSeconds"], ["target-seconds", "targetSeconds"],
    ["max-seconds", "maxSeconds"], ["timeout-seconds", "timeoutSeconds"],
    ["attempts", "attempts"], ["output", "output"]
  ]) if (raw[from] !== undefined) args[to] = raw[from];
  for (const name of ["minSeconds", "targetSeconds", "maxSeconds", "timeoutSeconds", "attempts"]) {
    args[name] = Number(args[name]);
  }
  if (args.maxTargetSeconds !== null) args.maxTargetSeconds = Number(args.maxTargetSeconds);
  if (!args.prompt || !args.voice) throw Error("Prompt and voice required");
  if (!(args.minSeconds > 0 && args.minSeconds <= args.maxSeconds &&
        args.targetSeconds > 0 && args.targetSeconds <= args.maxSeconds &&
        args.maxSeconds <= 300 && args.timeoutSeconds >= 5 &&
        args.attempts >= 1 && args.attempts <= 3 &&
        (args.maxTargetSeconds === null || (args.maxTargetSeconds >= args.minSeconds && args.maxTargetSeconds <= args.maxSeconds)))) throw Error("Invalid duration / retries");
  return args;
}

function setup(args) {
  return { setup: {
    model: "models/" + args.model.replace(/^models\//, ""),
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: args.voice } } }
    },
    systemInstruction: { parts: [{ text: (
      "You are a professional expressive voice actor. Perform the requested " +
      "script or original song in the exact language, voice style, emotion and " +
      "pacing requested. Aim for approximately " + args.targetSeconds +
      " seconds of continuous performance, ending with a natural, complete " +
      "final phrase. Control pitch, intonation, emotional dynamics, tempo and " +
      "melody as directed. Never end abruptly. Never speak an introduction. " +
      "No explanations or extra commentary."
    ) }] }
  } };
}

function receiveCompleteTurn(args, key) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== "function") {
      reject(Error("This Node version has no built-in WebSocket; Node >=22 is required"));
      return;
    }
    const url = WS_ENDPOINT + "?key=" + encodeURIComponent(key);
    const ws = new WebSocket(url);
    let ready = false;
    let settled = false;
    const pieces = [];
    let totalBytes = 0;
    const watchdog = setTimeout(() => stop(Error("Live response timeout")), args.timeoutSeconds * 1000);
    function stop(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      try { ws.close(1000, "done"); } catch {}
      if (error) reject(error);
      else resolve(result);
    }
    ws.addEventListener("open", () => {
      try { ws.send(JSON.stringify(setup(args))); }
      catch (e) { stop(e); }
    });
    ws.addEventListener("message", async (event) => {
      if (settled) return;
      try {
        const raw = typeof event.data === "string" ? event.data :
          Buffer.from(await event.data.arrayBuffer()).toString("utf8");
        const msg = JSON.parse(raw);
        if (msg.error) throw Error("Google Live: " + String(msg.error.message || msg.error).slice(0, 250));
        if (Object.hasOwn(msg, "setupComplete")) {
          ready = true;
          ws.send(JSON.stringify({ clientContent: {
            turns: [{ role: "user", parts: [{ text: args.prompt }] }],
            turnComplete: true
          } }));
          return;
        }
        const sc = msg.serverContent || {};
        if (sc.interrupted) throw Error("Gemini interrupted the Live turn");
        for (const p of sc.modelTurn?.parts || []) {
          const a = p.inlineData;
          if (!a?.data) continue;
          const mime = (a.mimeType || "").toLowerCase();
          if (!mime.startsWith("audio/pcm") || (mime.includes("rate=") && !mime.includes("rate=24000"))) {
            throw Error("Unexpected Gemini audio MIME: " + mime.slice(0, 60));
          }
          const pcm = Buffer.from(a.data, "base64");
          pieces.push(pcm);
          totalBytes += pcm.length;
          if (totalBytes > args.maxSeconds * BYTES_PER_SECOND) {
            throw Error("Complete output exceeds maximum allowed audio duration");
          }
        }
        if (sc.turnComplete) {
          if (!ready || totalBytes < args.minSeconds * BYTES_PER_SECOND || totalBytes % 2) {
            throw Error("Gemini Live turn complete but audio too short or invalid (" +
              (totalBytes / BYTES_PER_SECOND).toFixed(2) + " seconds)");
          }
          const fullSeconds = totalBytes / BYTES_PER_SECOND;
          if (args.maxTargetSeconds !== null && fullSeconds > args.maxTargetSeconds) {
            throw Error("Completed performance too long (" + fullSeconds.toFixed(2) +
              "s, expected at most " + args.maxTargetSeconds + "s); retrying without trimming");
          }
          stop(null, { pcm: Buffer.concat(pieces, totalBytes), totalSeconds: fullSeconds });
        }
      } catch (e) { stop(e); }
    });
    ws.addEventListener("error", () => stop(Error("Gemini WebSocket transport failed")));
    ws.addEventListener("close", (event) => {
      if (!settled) stop(Error("Gemini Live closed before turnComplete; close code " + event.code));
    });
  });
}

function wavFromCompletedTurn(pcm) {
  // Preserve 100% of the complete Gemini Live answer. Never trim or fade.
  const body = Buffer.from(pcm);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + body.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

async function main() {
  const args = argsFromCli();
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Error("Missing GEMINI_API_KEY repository secret");
  console.log("Zero-install runner: Node " + process.version + ", WebSocket " +
    typeof WebSocket + ", voice " + args.voice + ", target " + args.targetSeconds +
    "s, allowed range " + args.minSeconds + "–" + String(args.maxTargetSeconds) + "s");
  for (let attempt = 1; attempt <= args.attempts; attempt++) {
    try {
      const result = await receiveCompleteTurn(args, key);
      if (args.maxTargetSeconds !== null && result.totalSeconds > args.maxTargetSeconds) {
        throw Error("Completed audio is too long: " + result.totalSeconds.toFixed(2) + "s");
      }
      const wav = wavFromCompletedTurn(result.pcm);
      fs.mkdirSync(path.dirname(args.output), { recursive: true });
      const temporary = args.output + ".partial";
      fs.writeFileSync(temporary, wav);
      fs.renameSync(temporary, args.output);
      console.log("COMPLETE GEMINI LIVE WAV:", args.output,
        "source", result.totalSeconds.toFixed(2) + "s",
        "file", ((wav.length - 44) / BYTES_PER_SECOND).toFixed(2) + "s");
      return;
    } catch (e) {
      console.error("Attempt " + attempt + "/" + args.attempts + ": " +
        String(e.message || e).replaceAll(key, "[REDACTED]"));
    }
  }
  throw Error("No complete audio generated, so no artifact will be published");
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });
