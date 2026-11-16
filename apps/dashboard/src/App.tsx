import { useCallback, useEffect, useState } from "react";
import {
  API_KEY,
  api,
  receiver,
  type Activity,
  type Chaos,
  type DeadDelivery,
  type ReceiverStats,
  type Stats,
} from "./api";

const EVENT_TYPES = ["invoice.paid", "user.created", "order.shipped", "invoice.failed"];
const HISTORY = 90;
const fmt = new Intl.NumberFormat("en-US");

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [rx, setRx] = useState<ReceiverStats | null>(null);
  const [chaos, setChaos] = useState<Chaos>({ failRate: 0, latencyMs: 0, outage: false });
  const [feed, setFeed] = useState<(Activity & { key: string })[]>([]);
  const [dead, setDead] = useState<DeadDelivery[]>([]);
  const [history, setHistory] = useState<number[]>(() => Array(HISTORY).fill(0));
  const [live, setLive] = useState(false);
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null);

  // Poll aggregate stats once per second.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [s, r] = await Promise.all([api<Stats>("/v1/stats"), receiver<ReceiverStats>("/stats")]);
        if (!alive) return;
        setStats(s);
        setRx(r);
        setHistory((h) => [...h.slice(1), s.throughput]);
        if (s.dead > 0) setDead(await api<DeadDelivery[]>("/v1/deliveries?status=dead&limit=8"));
        else setDead([]);
      } catch {
        /* backend restarting — keep last values */
      }
    };
    void tick();
    const id = setInterval(tick, 1000);
    receiver<Chaos>("/chaos").then(setChaos).catch(() => {});
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Live attempt feed over Server-Sent Events.
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    let disposed = false;

    const connect = () => {
      es = new EventSource(`/api/v1/stream?key=${encodeURIComponent(API_KEY)}`);
      es.onopen = () => setLive(true);
      es.onerror = () => {
        setLive(false);
        // EventSource gives up for good after a non-200 (e.g. a 502 while the API restarts),
        // so reconnect ourselves.
        if (es?.readyState === EventSource.CLOSED && !disposed) retry = setTimeout(connect, 2000);
      };
      es.onmessage = (msg) => {
        const batch = JSON.parse(msg.data) as Activity[];
        setFeed((f) => [...batch.reverse().map((a) => ({ ...a, key: `${a.deliveryId}-${a.at}-${seq++}` })), ...f].slice(0, 40));
      };
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      es?.close();
    };
  }, []);

  const updateChaos = useCallback((patch: Partial<Chaos>) => {
    setChaos((c) => ({ ...c, ...patch }));
    receiver<Chaos>("/chaos", { method: "PUT", body: JSON.stringify(patch) }).catch(() => {});
  }, []);

  const send = async (total: number) => {
    setSending({ done: 0, total });
    let next = 0;
    let done = 0;
    const lane = async () => {
      while (next < total) {
        const i = next++;
        await api("/v1/events", {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({
            type: EVENT_TYPES[i % EVENT_TYPES.length],
            payload: { orderId: `ord_${i}`, amount: 1000 + ((i * 37) % 9000), currency: "EUR" },
          }),
        }).catch(() => {});
        if (++done % 20 === 0 || done === total) setSending({ done, total });
      }
    };
    await Promise.all(Array.from({ length: 24 }, lane));
    setSending(null);
  };

  const reset = async () => {
    await Promise.all([api("/v1/demo/reset", { method: "POST" }), receiver("/reset", { method: "POST" })]);
    setChaos({ failRate: 0, latencyMs: 0, outage: false });
    setFeed([]);
    setHistory(Array(HISTORY).fill(0));
  };

  const replayAll = () => api("/v1/deliveries/replay-dead", { method: "POST" }).catch(() => {});

  const s = stats;
  const pendingWork = s ? s.inflight + s.retrying : 0;
  const settled = !!s && s.total > 0 && pendingWork === 0 && !sending;
  const lost = s && rx ? Math.max(0, s.total - rx.unique - pendingWork - s.dead) : 0;
  const firstTryRate = s && s.succeeded > 0 ? (s.firstTry / s.succeeded) * 100 : null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
      <Header live={live} sending={sending} onSend={send} onReset={reset} />

      <section className="mt-6 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Guarantee stats={s} rx={rx} lost={lost} settled={settled} pendingWork={pendingWork} />
        <ChaosPanel chaos={chaos} rx={rx} onChange={updateChaos} />
      </section>

      <section className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Events accepted" value={s?.events} />
        <Kpi label="Delivered" value={s?.succeeded} tone="ok" />
        <Kpi label="In flight" value={s?.inflight} />
        <Kpi label="Retrying" value={s?.retrying} tone={s && s.retrying > 0 ? "warn" : undefined} />
        <Kpi label="Dead letter" value={s?.dead} tone={s && s.dead > 0 ? "bad" : undefined} />
        <Kpi label="p95 latency" value={s?.p95Ms ?? undefined} suffix="ms" />
      </section>

      <section className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Deliveries / second" right={<Mono>{s ? `${fmt.format(s.throughput)}/s` : "—"}</Mono>}>
          <Sparkline values={history} />
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500">
            <span>
              First-try success{" "}
              <Mono className="text-zinc-300">{firstTryRate === null ? "—" : `${firstTryRate.toFixed(1)}%`}</Mono>
            </span>
            <span>
              Total deliveries <Mono className="text-zinc-300">{s ? fmt.format(s.total) : "—"}</Mono>
            </span>
          </div>
        </Card>
        <Card title="Live attempts" right={<span className="text-xs text-zinc-500">Server-Sent Events</span>}>
          <Feed items={feed} />
        </Card>
      </section>

      {dead.length > 0 && (
        <section className="mt-4">
          <Card
            title="Dead-letter queue"
            right={
              <button
                onClick={replayAll}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium hover:border-emerald-500 hover:text-emerald-400"
              >
                Replay all
              </button>
            }
          >
            <DeadTable rows={dead} />
          </Card>
        </section>
      )}

      <footer className="mt-8 text-center text-xs text-zinc-600">
        Outbox in Postgres · BullMQ dispatch · exponential backoff with jitter · circuit breaker · Standard Webhooks
        signatures
      </footer>
    </div>
  );
}

function Header({
  live,
  sending,
  onSend,
  onReset,
}: {
  live: boolean;
  sending: { done: number; total: number } | null;
  onSend: (n: number) => void;
  onReset: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div className="grid size-9 place-items-center rounded-lg bg-emerald-500 text-zinc-950">
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h9m0 0-3.5-3.5M14 12l-3.5 3.5M18 7v10" />
          </svg>
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Relay</h1>
          <p className="text-xs text-zinc-500">Reliable webhook delivery · tenant Acme Inc</p>
        </div>
        <span
          className={`ml-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
            live ? "bg-emerald-500/10 text-emerald-400" : "bg-zinc-800 text-zinc-400"
          }`}
        >
          <span className={`size-1.5 rounded-full ${live ? "animate-pulse bg-emerald-400" : "bg-zinc-500"}`} />
          {live ? "Live" : "Connecting"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {sending ? (
          <span className="tabular text-sm text-zinc-400">
            Sending <Mono className="text-zinc-100">{fmt.format(sending.done)}</Mono> / {fmt.format(sending.total)}
          </span>
        ) : (
          <>
            <button
              onClick={() => onSend(1000)}
              className="rounded-md bg-emerald-500 px-3.5 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"
            >
              Send 1,000 events
            </button>
            <button
              onClick={() => onSend(10000)}
              className="rounded-md border border-zinc-700 px-3.5 py-2 text-sm font-medium hover:border-zinc-500"
            >
              10,000
            </button>
          </>
        )}
        <button onClick={onReset} className="rounded-md px-3 py-2 text-sm text-zinc-500 hover:text-zinc-200">
          Reset
        </button>
      </div>
    </header>
  );
}

function Guarantee({
  stats,
  rx,
  lost,
  settled,
  pendingWork,
}: {
  stats: Stats | null;
  rx: ReceiverStats | null;
  lost: number;
  settled: boolean;
  pendingWork: number;
}) {
  const ok = settled && lost === 0 && (stats?.dead ?? 0) === 0;
  return (
    <div
      className={`rounded-xl border p-5 transition-colors ${
        ok ? "border-emerald-500/40 bg-emerald-500/[0.06]" : "border-zinc-800 bg-zinc-900/50"
      }`}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-400">Delivery guarantee</h2>
        <span className="text-xs text-zinc-500">
          {!stats?.total ? "idle" : settled ? "settled" : `${fmt.format(pendingWork)} still in progress`}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <Big label="Deliveries created" value={stats?.total} />
        <Big label="Confirmed by consumer" value={rx?.unique} tone="ok" />
        <Big label="Lost" value={stats?.total ? lost : undefined} tone={lost > 0 ? "bad" : "ok"} />
      </div>
      <p className="mt-4 text-sm text-zinc-400">
        {ok ? (
          <>
            <span className="font-medium text-emerald-400">Every delivery reached its endpoint.</span>{" "}
            {rx && rx.chaosRejected > 0 && (
              <>
                {fmt.format(rx.chaosRejected)} requests failed on the way and were retried automatically
                {rx.duplicates > 0 && <>; {fmt.format(rx.duplicates)} redeliveries were deduplicated by the consumer</>}.
              </>
            )}
          </>
        ) : (
          "Counts compare what Relay accepted with what the consumer actually received and verified (HMAC + dedup by webhook-id)."
        )}
      </p>
    </div>
  );
}

function ChaosPanel({
  chaos,
  rx,
  onChange,
}: {
  chaos: Chaos;
  rx: ReceiverStats | null;
  onChange: (p: Partial<Chaos>) => void;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-400">Chaos — consumer endpoint</h2>
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <span className={chaos.outage ? "font-semibold text-red-400" : "text-zinc-500"}>Outage</span>
          <button
            role="switch"
            aria-checked={chaos.outage}
            onClick={() => onChange({ outage: !chaos.outage })}
            className={`relative h-5 w-9 rounded-full transition-colors ${chaos.outage ? "bg-red-500" : "bg-zinc-700"}`}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${chaos.outage ? "left-[18px]" : "left-0.5"}`}
            />
          </button>
        </label>
      </div>
      <Slider
        label="Failure rate"
        value={Math.round(chaos.failRate * 100)}
        max={90}
        step={5}
        suffix="%"
        onChange={(v) => onChange({ failRate: v / 100 })}
      />
      <Slider
        label="Added latency"
        value={chaos.latencyMs}
        max={2000}
        step={50}
        suffix="ms"
        onChange={(v) => onChange({ latencyMs: v })}
      />
      <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-zinc-800 pt-4 text-xs">
        <Mini label="Requests" value={rx?.requests} />
        <Mini label="Failed by chaos" value={rx?.chaosRejected} tone="warn" />
        <Mini label="Dupes absorbed" value={rx?.duplicates} />
      </dl>
    </div>
  );
}

function Slider(props: { label: string; value: number; max: number; step: number; suffix: string; onChange: (v: number) => void }) {
  return (
    <label className="mt-4 block">
      <div className="flex justify-between text-xs">
        <span className="text-zinc-400">{props.label}</span>
        <Mono className="text-zinc-200">
          {props.value}
          {props.suffix}
        </Mono>
      </div>
      <input
        type="range"
        min={0}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="mt-2 w-full"
      />
    </label>
  );
}

type Tone = "ok" | "warn" | "bad";
const toneClass = (t?: Tone) =>
  t === "ok" ? "text-emerald-400" : t === "warn" ? "text-amber-400" : t === "bad" ? "text-red-400" : "text-zinc-100";

function Kpi({ label, value, suffix, tone }: { label: string; value?: number; suffix?: string; tone?: Tone }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`tabular mt-1 font-mono text-xl font-semibold ${toneClass(tone)}`}>
        {value === undefined ? "—" : fmt.format(value)}
        {value !== undefined && suffix && <span className="ml-0.5 text-sm text-zinc-500">{suffix}</span>}
      </div>
    </div>
  );
}

function Big({ label, value, tone }: { label: string; value?: number; tone?: Tone }) {
  return (
    <div>
      <div className={`tabular font-mono text-3xl font-semibold sm:text-4xl ${toneClass(tone)}`}>
        {value === undefined ? "—" : fmt.format(value)}
      </div>
      <div className="mt-1 text-xs text-zinc-500">{label}</div>
    </div>
  );
}

function Mini({ label, value, tone }: { label: string; value?: number; tone?: Tone }) {
  return (
    <div>
      <dt className="text-zinc-500">{label}</dt>
      <dd className={`tabular mt-0.5 font-mono text-sm ${value ? toneClass(tone) : "text-zinc-300"}`}>
        {value === undefined ? "—" : fmt.format(value)}
      </dd>
    </div>
  );
}

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-400">{title}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

function Mono({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`tabular font-mono ${className}`}>{children}</span>;
}

function Sparkline({ values }: { values: number[] }) {
  const w = 600;
  const h = 140;
  const max = Math.max(10, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - (v / max) * (h - 8) - 4] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const area = `${line}L${w},${h}L0,${h}Z`;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-36 w-full">
        <defs>
          <linearGradient id="fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={w} y1={h * f} y2={h * f} stroke="#27272a" strokeDasharray="4 6" />
        ))}
        <path d={area} fill="url(#fill)" />
        <path d={line} fill="none" stroke="#10b981" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="tabular absolute top-0 left-0 font-mono text-[10px] text-zinc-600">{fmt.format(max)}/s</span>
      <span className="absolute right-0 bottom-0 text-[10px] text-zinc-600">last 90 s</span>
    </div>
  );
}

const OUTCOME: Record<Activity["outcome"], { label: string; cls: string }> = {
  succeeded: { label: "200 OK", cls: "bg-emerald-500/10 text-emerald-400" },
  retrying: { label: "RETRY", cls: "bg-amber-500/10 text-amber-400" },
  deferred: { label: "CIRCUIT", cls: "bg-sky-500/10 text-sky-400" },
  dead: { label: "DEAD", cls: "bg-red-500/10 text-red-400" },
};

function Feed({ items }: { items: (Activity & { key: string })[] }) {
  if (!items.length) {
    return <div className="grid h-56 place-items-center text-sm text-zinc-600">Send some events to see deliveries stream in.</div>;
  }
  return (
    <ul className="h-56 space-y-1 overflow-hidden font-mono text-xs">
      {items.map((a) => {
        const o = OUTCOME[a.outcome];
        const label = a.outcome === "retrying" && a.statusCode ? String(a.statusCode) : a.outcome === "retrying" && a.error ? "ERR" : o.label;
        return (
          <li key={a.key} className="feed-in flex items-center gap-2 whitespace-nowrap">
            <span className={`w-16 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold ${o.cls}`}>{label}</span>
            <span className="w-28 shrink-0 truncate text-zinc-300">{a.eventType}</span>
            <span className="min-w-0 flex-1 truncate text-zinc-500">{a.endpoint}</span>
            <span className="w-12 shrink-0 text-right text-zinc-500">#{a.attempt}</span>
            <span className="w-14 shrink-0 text-right text-zinc-600">{a.latencyMs !== undefined ? `${a.latencyMs}ms` : ""}</span>
          </li>
        );
      })}
    </ul>
  );
}

function DeadTable({ rows }: { rows: DeadDelivery[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-zinc-500">
          <tr>
            <th className="pb-2 font-medium">Event</th>
            <th className="pb-2 font-medium">Endpoint</th>
            <th className="pb-2 font-medium">Attempts</th>
            <th className="pb-2 font-medium">Last error</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-zinc-800">
              <td className="py-2 text-zinc-300">{r.eventType}</td>
              <td className="py-2 text-zinc-500">{new URL(r.endpointUrl).pathname}</td>
              <td className="py-2">{r.attempts}</td>
              <td className="py-2 text-red-400">{r.lastStatusCode ?? r.lastError}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

