// ElevenLabs TTS client with sha256 cache. Ported from horse-jarvis
// server/services/tts.ts, mapped onto this project's audio_cache schema
// (hash / voiceId / model / text / mp3Path). Throws only when a key is set but
// the request fails; callers guard on hasElevenLabsKey() for graceful boot.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../storage";
import { audioCache } from "@shared/schema";
import { sanitizeForTTS } from "./sanitizer";

export const AUDIO_DIR = path.join(process.cwd(), "server", "audio_cache");
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true };

export function hasElevenLabsKey(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

// Default ElevenLabs voices. US (Daniel, American) covers the North-American
// leagues; UK (Dorothy, British female) reads the soccer briefs. The legacy
// ELEVENLABS_VOICE_ID is honored as a fallback for both when the new per-region
// vars aren't set, so existing deployments keep their current voice.
const DEFAULT_VOICE_US = "onwK4e9ZLuTAKqWW03F9";
const DEFAULT_VOICE_UK = "ThT5KcBeYPX3keUQqHPh";

function usVoiceId(): string {
  return process.env.ELEVENLABS_VOICE_ID_US || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_US;
}
function ukVoiceId(): string {
  return process.env.ELEVENLABS_VOICE_ID_UK || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_UK;
}

// Resolve the ElevenLabs voice for a sport: soccer → UK, everything else → US.
export function getVoiceIdForSport(sport: string): string {
  return sport === "soccer" ? ukVoiceId() : usVoiceId();
}

export function hashScript(voiceId: string, model: string, text: string): string {
  return crypto.createHash("sha256").update(`${voiceId}|${model}|${text}`).digest("hex");
}

export interface SpeechResult {
  audioUrl: string;
  hash: string;
  cached: boolean;
}

// Generate (or return cached) speech. The voice is chosen from the pick's sport
// (soccer → UK, otherwise US). The voiceId is part of the cache hash, so the
// same script spoken by two voices yields distinct cached files. audioUrl
// resolves to /api/audio/:hash.
export async function generateSpeech(text: string, sport = "mlb"): Promise<SpeechResult> {
  const voiceId = getVoiceIdForSport(sport);
  const model = process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5";
  const speakable = sanitizeForTTS(text);
  const hash = hashScript(voiceId, model, speakable);

  const existing = db.select().from(audioCache).where(eq(audioCache.hash, hash)).get();
  if (existing && fs.existsSync(existing.mp3Path)) {
    return { audioUrl: `/api/audio/${hash}`, hash, cached: true };
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text: speakable, model_id: model, voice_settings: VOICE_SETTINGS }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${err.slice(0, 300)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const mp3Path = path.join(AUDIO_DIR, `${hash}.mp3`);
  fs.writeFileSync(mp3Path, buffer);

  db.delete(audioCache).where(eq(audioCache.hash, hash)).run();
  db.insert(audioCache).values({ hash, text: speakable, voiceId, model, mp3Path }).run();

  return { audioUrl: `/api/audio/${hash}`, hash, cached: false };
}

export function getCachedFilePath(hash: string): string | null {
  const row = db.select().from(audioCache).where(eq(audioCache.hash, hash)).get();
  if (!row || !fs.existsSync(row.mp3Path)) return null;
  return row.mp3Path;
}
