import { Link, useRoute } from "wouter";
import { Construction } from "lucide-react";

const LABELS: Record<string, string> = {
  nfl: "NFL",
  nba: "NBA",
  nhl: "NHL",
  ncaaf: "NCAAF",
  ncaab: "NCAAB",
};

export default function SportStub() {
  const [, params] = useRoute("/sports/:sport");
  const sport = params?.sport ?? "";
  const label = LABELS[sport] ?? sport.toUpperCase();

  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-card-border bg-navy-card p-16 text-center" data-testid="sport-stub">
      <Construction className="h-8 w-8 text-gold" />
      <h1 className="text-xl font-bold tracking-tight">{label} desk — coming soon</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        The {label} model is in calibration. The MLB desk is live today — props and additional sports follow once
        their data feeds clear validation.
      </p>
      <Link href="/" className="mt-2 rounded-lg bg-gold px-4 py-2 text-xs font-medium text-navy-bg hover:bg-gold-light" data-testid="link-to-mlb">
        Go to MLB board
      </Link>
    </div>
  );
}
