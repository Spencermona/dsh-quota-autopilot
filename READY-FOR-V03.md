# v0.3.0 shadow-staging acceptance

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
- Two independent safety reviews: GO after fixes; no blocker.
- Commit `02d6d75` pushed to `origin/main` and installed in the real Web profile by immutable commit spec.
- Restarted production reports package `0.3.0`, API/GUI HTTP 200, `automation.mode=shadow`, `effectiveMode=shadow`, `dailyCapUsd=5`, fresh ledger/quota/cost data.
- Production kill-switch exercised live: creating the file changed `effectiveMode` to `off` without restart; deleting it restored `shadow`.
- No production automation candidate has occurred yet (`automation-log.jsonl` absent), which matches the current healthy Kimi windows and DeepSeek cost below $5.

## Remaining gate before `enforce`

1. Soak in `shadow` until at least one real candidate is observed and reviewed.
2. Remove/disable the legacy mixed-preset `quota-mgr` request hook; two waterfalls must never compete.
3. Keep `enforce` disabled until both gates pass.
