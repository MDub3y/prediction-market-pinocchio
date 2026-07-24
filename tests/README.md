# Alley program tests

Fast, isolated tests against the real compiled program (`target/deploy/alley.so`) using
[litesvm](https://github.com/LiteSVM/litesvm) — no local validator required, and (unlike
the local-validator flow) it lets us directly forge account state, which is required to
exercise `resolve_market` (needs an account owned by the hardcoded oracle pubkey) and to
time-travel the clock for `emergency_refund`.

## Running

```sh
bun install
bun test
```

Run a single file: `bun test 03_limit_orders.test.ts`

## Layout

- `helpers.ts` — account/byte layout constants (verified field-by-field against
  `src/state.rs`, not assumed) and instruction builders for all 9 discriminators.
- `01_create_market.test.ts` … `06_stress_and_scaling.test.ts` — one file per
  concern, in rough dependency order.

## What passing tests here do (and don't) tell you

All 34 tests pass — but several intentionally assert the program's **current, buggy**
behavior (labeled `BUG:` / `⚠️ CONFIRMED`) so they double as regression evidence, not
just correctness checks. Search this directory for `CONFIRMED` to find them; each has a
comment explaining the discrepancy. Do not "fix" those assertions without also fixing the
underlying instruction — that will just make the bug regress silently.

Notably out of scope for these tests (deliberately, since they require infrastructure
this repo doesn't own): the real Txline oracle program, a live Geyser/RPC indexer, and
anything involving actual network latency or validator leader scheduling.
