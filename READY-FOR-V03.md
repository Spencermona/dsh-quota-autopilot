# v0.3.0 pre-deployment acceptance

## Scope

- Optional request-time safety routing with `off` / `shadow` / `enforce` modes.
- Default is `off`; no routing listener is registered.
- Immediate rollback through `<dataDir>/automation-kill-switch`.
- Decisions may target only provider/model pairs already returned by role resolution, and built-in Kimi/DeepSeek destinations must also have fresh non-reserve quota/balance.
- Stale quota and incomplete DeepSeek cost are excluded before automation.
- One `dailyBudgetUsd` drives GUI, state, modifiers, and automation; `panel.dailyCapUsd` is a deprecated compatibility alias.

## Safety behavior

- Kimi requests can move to the resolved worker role only when a fresh Kimi weekly/5h window crosses its `RESERVE` or `EMERGENCY` threshold (not when aggregate state is low only because DeepSeek balance is low).
- DeepSeek requests can move to a resolved Kimi role only when complete attributed daily cost is greater than `dailyBudgetUsd`.
- `shadow` logs the same candidate but returns the original request config.
- `enforce` preserves unrelated request config and clears inherited `reasoningEffort` when the target role does not define one.
- Candidate decisions append to `automation-log.jsonl`; `service.status().automation` reports configured/effective mode and rollback paths.

## Verification

- Unit: 34/34 passed.
- Plugin shape/integration: 9/9 passed.
- Client: 3/3 passed.
- Package shape: 4/4 passed.
- Legacy shadow router: 12/12 passed.
- `git diff --check`: clean (only Windows line-ending notices).

## Production gate still required

1. Independent code review has no blocker.
2. Commit v0.3.0, install into the real Web profile with `automation.mode: shadow`.
3. Confirm `/autopilot/api/status`, GUI client, ledger freshness, and `automation-log.jsonl` under real traffic.
4. Exercise the kill-switch in shadow mode and verify `effectiveMode: off` without restart.
5. Remove/disable the legacy mixed-preset `quota-mgr` request hook before enabling `enforce`; two waterfalls must never compete.
6. Keep `enforce` disabled until the shadow evidence is reviewed.
