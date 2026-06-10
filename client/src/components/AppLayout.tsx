import { Link, useLocation } from "wouter";
import { AlertsPanel } from "./AlertsPanel";
import { ScopeFull } from "./ScopeFull";
import { BankrollBadge } from "./BankrollBadge";

const SPORTS = [
  { key: "mlb", label: "MLB", href: "/", live: true },
  { key: "nfl", label: "NFL", href: "/sports/nfl", live: false },
  { key: "nba", label: "NBA", href: "/sports/nba", live: false },
  { key: "nhl", label: "NHL", href: "/sports/nhl", live: false },
  { key: "ncaaf", label: "NCAAF", href: "/sports/ncaaf", live: false },
  { key: "ncaab", label: "NCAAB", href: "/sports/ncaab", live: false },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const isActive = (href: string) =>
    href === "/" ? location === "/" : location.startsWith(href);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-gold/12 bg-navy-deep/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <Link href="/" className="flex items-center gap-2.5" data-testid="link-home">
            <span className="overflow-hidden rounded-lg border border-gold/25">
              <ScopeFull uid="nav" size={34} />
            </span>
            <span className="hidden flex-col leading-none sm:flex">
              <span className="gold-gradient-text font-display text-sm font-extrabold uppercase tracking-[0.22em]">
                Elite Edge
              </span>
              <span className="font-display text-[9px] font-bold uppercase tracking-[0.3em] text-muted-foreground">
                Analytics
              </span>
            </span>
          </Link>

          <BankrollBadge />

          <nav className="ml-2 flex items-center gap-1 overflow-x-auto" data-testid="nav-sports">
            {SPORTS.map((s) => (
              <Link
                key={s.key}
                href={s.href}
                className={`relative rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  isActive(s.href)
                    ? "bg-gold/15 text-gold"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`tab-sport-${s.key}`}
              >
                {s.label}
                {!s.live && (
                  <span className="ml-1 text-[9px] uppercase tracking-wider text-muted-foreground/60">soon</span>
                )}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/analytics"
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive("/analytics") ? "bg-gold/15 text-gold" : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid="link-analytics"
            >
              Analytics
            </Link>
            <Link
              href="/yesterday"
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive("/yesterday") ? "bg-gold/15 text-gold" : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid="link-yesterday"
            >
              Yesterday
            </Link>
            <Link
              href="/archive"
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive("/archive") ? "bg-gold/15 text-gold" : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid="link-archive"
            >
              Archive
            </Link>
            <Link
              href="/track-record"
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive("/track-record") ? "bg-gold/15 text-gold" : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid="link-track-record"
            >
              Track Record
            </Link>
            <AlertsPanel />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
