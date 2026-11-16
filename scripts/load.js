// k6 load test: fires EVENTS events at the API from VUS virtual users.
// Run with: pnpm load   (or EVENTS=1000 pnpm load)
import http from "k6/http";
import { check } from "k6";

const EVENTS = Number(__ENV.EVENTS || 10000);
const TYPES = ["invoice.paid", "user.created", "order.shipped", "invoice.failed"];

export const options = {
  scenarios: {
    burst: {
      executor: "shared-iterations",
      vus: Number(__ENV.VUS || 50),
      iterations: EVENTS,
      maxDuration: "10m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.001"],
    http_req_duration: ["p(95)<250"],
  },
};

export default function () {
  const i = __ITER + __VU * 1_000_000;
  const res = http.post(
    `${__ENV.API_URL}/v1/events`,
    JSON.stringify({
      type: TYPES[i % TYPES.length],
      payload: { orderId: `ord_${i}`, amount: 1000 + (i % 9000), currency: "EUR" },
    }),
    {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${__ENV.API_KEY}`,
        "idempotency-key": `k6-${__VU}-${__ITER}-${Date.now()}`,
      },
    },
  );
  check(res, { "accepted (202)": (r) => r.status === 202 });
}
