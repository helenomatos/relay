#!/usr/bin/env bash
# End-to-end guarantee test, run in CI:
#   1. bring the whole stack up
#   2. make the consumer fail 30% of requests
#   3. fire N events with k6, then take the consumer down for 15 s mid-flight
#   4. wait for the system to settle and assert: nothing lost, nothing dead,
#      and the consumer confirmed exactly one copy of every delivery.
set -euo pipefail

EVENTS="${EVENTS:-2000}"
API="http://localhost:3000"
RX="http://localhost:4000"
KEY="${DEMO_API_KEY:-rk_demo_7f3c9a1e5b2d4f6a8c0e}"
auth=(-H "authorization: Bearer $KEY")

# Tiny JSON reader so the script only needs node (no jq): jget 'o.total' <<<"$json"
jget() { node -pe "const o = JSON.parse(require('fs').readFileSync(0, 'utf8')); $1"; }

echo "==> starting stack"
docker compose up -d --build --wait api worker receiver

curl -sf -X POST "${auth[@]}" "$API/v1/demo/reset" >/dev/null
curl -sf -X POST "$RX/reset" >/dev/null
curl -sf -X PUT "$RX/chaos" -d '{"failRate":0.3}' >/dev/null
echo "==> consumer failing 30% of requests"

echo "==> firing $EVENTS events"
EVENTS="$EVENTS" docker compose --profile loadtest run --rm k6 &
K6_PID=$!

sleep 5
echo "==> consumer outage (15 s)"
curl -sf -X PUT "$RX/chaos" -d '{"outage":true}' >/dev/null
sleep 15
curl -sf -X PUT "$RX/chaos" -d '{"outage":false}' >/dev/null
echo "==> consumer back"

wait "$K6_PID"

echo "==> waiting for deliveries to settle"
for i in $(seq 1 120); do
  stats=$(curl -sf "${auth[@]}" "$API/v1/stats")
  pending=$(jget 'o.inflight + o.retrying' <<<"$stats")
  [ "$pending" -eq 0 ] && break
  [ $((i % 5)) -eq 0 ] && echo "    $pending still in progress"
  sleep 2
done

rx=$(curl -sf "$RX/stats")
total=$(jget o.total <<<"$stats")
succeeded=$(jget o.succeeded <<<"$stats")
dead=$(jget o.dead <<<"$stats")
pending=$(jget 'o.inflight + o.retrying' <<<"$stats")
unique=$(jget o.unique <<<"$rx")

echo
echo "deliveries created:      $total"
echo "delivered:               $succeeded"
echo "dead-lettered:           $dead"
echo "still pending:           $pending"
echo "consumer confirmed:      $unique (unique, signature-verified)"
echo "failed by chaos:         $(jget o.chaosRejected <<<"$rx")"
echo "duplicates absorbed:     $(jget o.duplicates <<<"$rx")"
echo "invalid signatures:      $(jget o.invalidSignature <<<"$rx")"

fail=0
[ "$pending" -eq 0 ] || { echo "FAIL: deliveries still pending"; fail=1; }
[ "$dead" -eq 0 ] || { echo "FAIL: $dead deliveries dead-lettered"; fail=1; }
[ "$succeeded" -eq "$total" ] || { echo "FAIL: delivered $succeeded of $total"; fail=1; }
[ "$unique" -eq "$total" ] || { echo "FAIL: consumer confirmed $unique of $total"; fail=1; }
[ "$(jget o.invalidSignature <<<"$rx")" -eq 0 ] || { echo "FAIL: invalid signatures"; fail=1; }

[ "$fail" -eq 0 ] && echo && echo "PASS: $total/$total delivered, 0 lost"
exit "$fail"
