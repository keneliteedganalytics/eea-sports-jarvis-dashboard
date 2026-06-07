import { useRef, useState } from "react";
import { Play, Pause, Loader2, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import type { BriefResponse } from "@/lib/types";

function Waveform({ playing }: { playing: boolean }) {
  return (
    <div className="flex items-end gap-[3px] h-6" aria-hidden="true">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className={`wave-bar w-[3px] rounded-full bg-gold ${playing ? "playing" : ""}`}
          style={{
            height: "100%",
            animationDelay: `${(i % 6) * 0.11}s`,
            opacity: playing ? 1 : 0.35,
            transform: playing ? undefined : "scaleY(0.3)",
          }}
        />
      ))}
    </div>
  );
}

// Per-pick analyst brief player. POSTs to generate (or fetch cached) the brief,
// shows the text, and plays the MP3 when ElevenLabs is configured.
export function JarvisPlayer({ pickId }: { pickId: string }) {
  const [loading, setLoading] = useState(false);
  const [brief, setBrief] = useState<BriefResponse | null>(null);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  async function loadAndPlay() {
    if (loading) return;
    if (!brief) {
      setLoading(true);
      try {
        const res = await apiRequest("POST", `/api/mlb/brief/${pickId}`);
        const data = (await res.json()) as BriefResponse;
        setBrief(data);
        if (data.audioUrl) {
          const audio = new Audio(data.audioUrl);
          audio.onended = () => setPlaying(false);
          audioRef.current = audio;
          await audio.play();
          setPlaying(true);
        }
      } catch {
        setBrief({ text: "Unable to generate brief.", audioUrl: null, available: false });
      } finally {
        setLoading(false);
      }
      return;
    }
    // Toggle playback for an already-loaded audio brief.
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      await audio.play();
      setPlaying(true);
    }
  }

  return (
    <div className="rounded-lg border border-gold/20 bg-black/20 p-3" data-testid="jarvis-player">
      <div className="flex items-center gap-3">
        <Button
          size="icon"
          className="h-10 w-10 shrink-0 rounded-full bg-gold text-navy-bg hover:bg-gold-light"
          onClick={loadAndPlay}
          disabled={loading}
          data-testid="button-brief-play"
        >
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : playing ? (
            <Pause className="h-5 w-5" />
          ) : (
            <Play className="h-5 w-5" />
          )}
        </Button>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-gold-dark">
            Jarvis · Sharp Desk Brief
          </div>
          {brief?.audioUrl ? (
            <Waveform playing={playing} />
          ) : (
            <div className="text-xs text-muted-foreground">
              {brief
                ? brief.available
                  ? "Ready"
                  : "Audio disabled — text brief below"
                : "Tap to generate analyst brief"}
            </div>
          )}
        </div>
        {brief && !brief.available && <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground/50" />}
      </div>
      {brief && (
        <p className="mt-3 text-sm leading-relaxed text-foreground/90" data-testid="text-brief">
          {brief.text}
        </p>
      )}
    </div>
  );
}
