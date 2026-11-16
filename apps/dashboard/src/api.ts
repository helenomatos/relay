export const API_KEY: string = import.meta.env.VITE_DEMO_API_KEY ?? "rk_demo_7f3c9a1e5b2d4f6a8c0e";

async function request<T>(base: string, path: string, init: RequestInit = {}, auth = false): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (auth) headers.set("authorization", `Bearer ${API_KEY}`);
  const res = await fetch(`${base}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json() as Promise<T>;
}

export const api = <T>(path: string, init?: RequestInit) => request<T>("/api", path, init, true);
export const receiver = <T>(path: string, init?: RequestInit) => request<T>("/receiver", path, init);

export interface Stats {
  events: number;
  total: number;
  succeeded: number;
  firstTry: number;
  inflight: number;
  retrying: number;
  dead: number;
  throughput: number;
  p95Ms: number | null;
}

export interface ReceiverStats {
  requests: number;
  accepted: number;
  duplicates: number;
  chaosRejected: number;
  invalidSignature: number;
  unique: number;
}

export interface Chaos {
  failRate: number;
  latencyMs: number;
  outage: boolean;
}

export interface Activity {
  deliveryId: string;
  eventType: string;
  endpoint: string;
  outcome: "succeeded" | "retrying" | "dead" | "deferred";
  attempt: number;
  statusCode?: number | null;
  latencyMs?: number;
  error?: string | null;
  at: number;
}

export interface DeadDelivery {
  id: string;
  eventType: string;
  endpointUrl: string;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  updatedAt: string;
}
