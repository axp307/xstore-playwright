# Xstore Scan Speed: Test and Mitigation Plan

## Goal

Production Xstore scan speeds are too slow, and no one can pin down which API
calls or user scenarios add the overhead. This plan uses this repo to measure
scans precisely, find where the time goes, and guide mitigation.

## Current capabilities

- `Scan sale items … and record scan times for each item` records the time from
  entering the ID until the cart updates, stored as `scanTimes` in the JSON report.
- Per-step timing separates execution time from `--slow-mo` and observation delay.
- Playwright can capture network, trace and HAR data, but the repo does not use it yet.

**Gap:** we measure "scan took N s" but cannot say where the time went. It could
be the UI, Xstore's server, or an external call (pricing, item master, tax,
promotions, loyalty). Closing that gap is the first job.

## Test plan

### Phase 0: make the measurement trustworthy

1. Run with `--slow-mo 0` and `stepDelayMs: 0`. The docs currently use
   `--slow-mo 400`, which inflates scan times.
2. Repeat each scan N times (30 or more) and report p50, p95, p99 and max
   instead of a single number.
3. Add a correlation ID per scan to every report entry: run ID, item, store,
   register, build, timestamp.

### Phase 1: decompose each scan (new instrumentation)

- Hook `page.on('request' | 'response' | 'requestfinished')` during the scan
  window. Record URL pattern, method, status, TTFB, total time and payload size,
  and attribute them to the item's `scanTimes` entry.
- Add `performance.mark` and `PerformanceObserver` timing in the page, plus a
  Playwright trace (`context.tracing`) for the slowest scans.
- Split each scan into time to first request, server time, time to last
  response and time to render, to tell network, server and UI cost apart.
- Pull matching server-side Xstore and downstream logs by timestamp or
  correlation ID to get the true external-call time.

### Phase 2: scenario matrix (new `.xstore` scripts)

| Dimension | Variants |
|---|---|
| Cold vs warm | first scan after login vs the Nth scan; first scan of an item vs a repeat |
| Item type | simple, serialized, promo or discounted, tax-special, non-existent or invalid ID, high-quantity |
| Cart size | the 1st, 10th, 50th and 100th line (checks for O(n) growth per scan) |
| Customer | DIY vs a loyalty or account customer |
| Entry | scan vs keyed vs search; the same ID repeated (quantity change) |
| Context | store, register, time of day, build or config version |
| Load | N parallel registers on the same store |
| Failure | slow or blocked external service (Playwright `route` adding latency or failures) to measure timeout and retry behaviour |

### Phase 3: baseline, regression and CI

- Commit a baseline JSON and fail the run when p95 is more than X% above it.
- Schedule runs (nightly against a test instance, plus a low-frequency
  synthetic probe) to build a trend over time.
- Produce a summary report: top 10 slowest endpoints and time per phase.

## Industry approaches to slow lookups behind unavoidable external calls

- **Measure tail latency:** Google's *The Tail at Scale* (Dean and Barroso) and
  Amazon's p99 focus. Optimise p95 and p99, not the average.
- **Distributed tracing:** Google Dapper, Uber Jaeger, OpenTelemetry. One trace
  per scan across Xstore and its downstream services; Phase 1 correlation IDs
  approximate this.
- **Cache with stale-while-revalidate:** Netflix EVCache, HTTP SWR. Item and
  price data changes rarely, so serve cached data immediately and refresh it in
  the background.
- **Prefetch and local replicas:** offline-first retail POS designs (e.g. Square,
  Shopify POS) and CDN edge caching. Sync the item master to the register and
  treat the remote call as a fallback.
- **Timeouts, retries and hedging:** hedged requests (*The Tail at Scale*),
  circuit breakers (Netflix Hystrix, now Resilience4j), deadline propagation.
  Fail fast to a default or cached value rather than blocking the cashier.
- **Request coalescing and batching:** Facebook DataLoader, Go `singleflight`.
  Collapse duplicate or concurrent lookups for the same item into one call.
- **Async off the critical path:** Stripe and Shopify push non-blocking work
  (loyalty, analytics, receipts) to queues so the scan returns without it.
- **Optimistic UI and progressive rendering:** add the line instantly with a
  pending price, then update when the external response arrives.
- **Performance budgets with SLOs:** Etsy and Google set a target such as
  "scan p95 under 1 s" and alert on regressions. This is Phase 3.

## Likely mitigations once data points to a cause

1. **External call dominates:** cache or prefetch item and price data, coalesce
   duplicate calls, add timeouts with fallback.
2. **Serial calls:** parallelise independent lookups.
3. **Cart growth:** fix per-scan recalculation (promos or tax over the whole cart).
4. **Cold scans only:** warm caches and connections at login.
5. **UI latency:** reduce render or wait overhead, including our own wait
   conditions in `src/xstore.ts`.

## Proposed next step

Implement Phase 0 and Phase 1 first, since everything else depends on them:
network and timing capture in `src/runner.ts` and `src/xstore.ts`, repeat runs,
percentile reporting, and correlation IDs in the JSON report.
