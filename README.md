# dsh-quota-autopilot

> Quota-aware model routing advisor for dsh (DeepSeek Harness).

[![npm version](https://img.shields.io/npm/v/dsh-quota-autopilot)](https://www.npmjs.com/package/dsh-quota-autopilot)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

English · [中文](#dsh-quota-autopilot-中文)

---

## What it does

- **Role-based routing advisor.** The router thinks in four roles — `main` / `worker` / `long-context` / `reviewer` — never in hardcoded model names. A built-in knowledge base maps known providers to known models (`deepseek-official`: main = `deepseek-v4-pro`, worker = `deepseek-v4-flash`, reviewer = `deepseek-v4-pro`; `kimi-coding`: long-context = `k3`). At startup the plugin probes each provider's actually-available models and fills roles from the knowledge base. Unknown models never enter routing (an anti-burn guardrail) unless you explicitly map one to a role in config. When a provider isn't configured, `main` falls back to that provider's deployment default model.
- **Quota awareness.** Polls Kimi `/v1/usages` and DeepSeek `/user/balance` on a configurable interval and feeds the numbers into a five-level state machine: `AGGRESSIVE` / `NORMAL` / `CONSERVE` / `RESERVE` / `EMERGENCY`.
- **Data freshness.** Every quota value carries per-source freshness (`collectedAt` / `ageMs` / `stale`). A snapshot older than `poll.staleAfterMin` (default 15 min) is marked stale and excluded from state/routing decisions — but still shown, so you can tell "no signal" from "signal says fine". DeepSeek today-cost reports `incomplete` + `unknownModels` instead of silently treating an unknown rate as $0.
- **GUI quota pill (web profile).** Mounts a read-only pill in the composer dock showing Kimi week/5h, DeepSeek balance, today's cost, Codex (ChatGPT subscription) and local runtimes (Ollama/LM Studio, ∞), with stale markers. It is served from this plugin's own `/autopilot/api/status` route — no external status file.
- **Auto-calibration.** Silently accumulates account snapshots and per-request attribution data; once it has ≥24 h of span and a net increase of ≥3 quota points, it derives *your own* tokens-per-point rate and keeps sliding-correcting it as new windows arrive. Until calibration completes, anything needing that ratio reports `learning` — it never guesses.
- **Advisory only.** The plugin never touches actual routing. Advice vs. actual consumption is written to a local shadow log for later comparison.

## Install

### From GitHub (recommended; no npm account required)

```bash
dsh plugin --profile web add "github:Spencermona/dsh-quota-autopilot#v0.2.0"
```

`dsh plugin` forwards package specs to pnpm, so a public GitHub repository can be installed directly. Neither the publisher nor the installer needs an npm account for this route. **pnpm is required** — it is what `dsh plugin` drives under the hood, so make sure pnpm is available on your PATH before installing.

### From npm (after a registry release exists)

```bash
dsh plugin --profile web add dsh-quota-autopilot
```

Then add a root-level insert row to `$DSH_HOME/profiles/web/cordis.patch.yml` (i.e. `~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: autopilot
      name: 'dsh-quota-autopilot'
      # config: { dailyBudgetUsd: 5 }   # optional overrides
```

The patch file is hot-watched — saving takes effect immediately; restarting dsh works too.

**Auto preset (optional).** Copy the `presets/auto/` directory from this package to `~/.dsh/.agent-presets/auto/` (or run `node node_modules/dsh-quota-autopilot/scripts/install.mjs` to have it done for you), then pick **Auto** in the session preset selector. Only Auto preset sessions see the `route_consult` tool; every other preset is completely unaware of the plugin's advisory side (the read-only quota service is still available host-wide). ⚠️ **Install order matters**: the Auto preset waits for the host plugin's `autopilot` service — install the plugin first, then copy the preset; done the other way round, the Auto preset will not finish mounting.

## Configuration

All defaults live in `src/config.mjs`; override any of them via the row's `config` in `cordis.patch.yml`. Main keys:

| Key | Meaning | Default |
| --- | --- | --- |
| `credentials.kimiKeyName` / `credentials.deepseekKeyName` | **Names** of the keys in `$DSH_HOME/.credentials.yaml` — never key values | `KIMI_CODING_API_KEY` / `DEEPSEEK_API_KEY` |
| `poll.intervalMin` | Quota polling interval (minutes) | `5` |
| `poll.staleAfterMin` | Age (minutes) after which a snapshot is stale and excluded from state/routing (still displayed) | `15` |
| `poll.kimiUsageUrl` / `poll.deepseekBalanceUrl` / `poll.timeoutMs` | Endpoints and request timeout | see defaults |
| `panel.*` | GUI pill: `codex`/`local` toggles, `dailyCapUsd`, `lowPoints`/`warnPoints`, `warnBalanceUsd`/`lowBalanceUsd` display thresholds | see defaults |
| `dailyBudgetUsd` | Daily DeepSeek budget used by modifiers and the state machine | `5` |
| `calibration.minSpanHours` / `minPointDelta` / `driftRelearnPct` | Auto-calibration trigger (≥24 h span, ≥3 points net) and relearn drift threshold | `24` / `3` / `30` |
| `roles` | Explicit role → `{provider, model, reasoningEffort?}` mapping; the only way an unknown model enters routing | `{}` |
| `rules` / `fallback` / `modifiers` / `stateMachine` / `stateActions` | Routing rules, score modifiers, and quota state thresholds — all reference **role names**, never model names | see `src/config.mjs` |
| `dataDir` | Explicit plugin data directory override | auto-resolved |

Overrides are **deep-merged** over the defaults: plain objects merge recursively; **arrays are replaced wholesale** (rule lists are authored as units).

The plugin also registers a settings namespace `autopilot`, so `settings.yaml` can carry user-level overrides on top of the row config.

## Data sources (transparency)

- **Kimi quota** — `GET https://api.kimi.com/coding/v1/usages` (plural). ⚠️ **This endpoint is undocumented and may change at any time.** The plugin parses it defensively (string numbers coerced, NaN tolerated) and, on schema drift, records a `parse_error` and warns instead of crashing.
- **DeepSeek balance** — `GET https://api.deepseek.com/user/balance` (officially documented). It only reports a monetary balance; there is no token dimension.
- **dsh's own durable logs** — `~/.dsh/sessions/**/session.jsonl.zstd`. These are the only precise source of real per-request token usage, and the plugin reads them **strictly read-only**.

### What public online data can and cannot replace

Public documentation can safely bootstrap model names, context limits, capabilities, and published API prices. It **cannot** truthfully replace your account's remaining quota, reset window, balance, actual token usage, or personal tokens-per-point ratio. When account data is unavailable, the plugin keeps those fields unavailable/`learning` rather than fabricating a value; routing then falls back to resolved roles and non-quota rules. This conservative degradation is intentional.

## Privacy

- Everything stays on your machine. All writes are confined to the plugin data directory (`<profile>/data/dsh-quota-autopilot/` under `$DSH_HOME/profiles/`, or `~/.dsh/plugin-data/dsh-quota-autopilot/` as fallback).
- Core quota polling only calls the Kimi and DeepSeek endpoints listed above. When the web panel's optional Codex display is enabled (default), the local Codex OAuth token is sent only to `https://chatgpt.com/backend-api/wham/usage`; set `panel.codex: false` to disable it. Optional local-runtime probes only call loopback Ollama/LM Studio endpoints.
- API keys are read **by name** from the local credentials store (key names are configurable); you never paste a key into any config file. In every log and output a key is shown as first-4 + last-4 characters only (e.g. `sk-a****wxyz`).

## Requirements

- Node.js ≥ 22.15 (uses the native `node:sqlite` module)
- dsh (verified with the `web` profile)
- pnpm (required by the GitHub direct-install route — `dsh plugin` forwards the spec to pnpm)
- Windows / macOS / Linux

## Upgrading & migration

### From v0.1.0 (this package)

1. Re-install at the new tag:
   ```bash
   dsh plugin --profile web add "github:Spencermona/dsh-quota-autopilot#v0.2.0"
   ```
2. The Auto preset is unchanged; if you copied `presets/auto/` earlier, re-run
   `node node_modules/dsh-quota-autopilot/scripts/install.mjs --force` to pick up any changes.
3. The web GUI pill is now served by this package itself (no extra step) — the
   client bundle is discovered through the package's `dsh.client` manifest and
   mounts in the web profile automatically.

### From the standalone `dsh-quota-panel`

v0.2.0 replaces the old standalone GUI package (which read an external
`quota-status.json`) with a built-in panel served directly from the autopilot
service. To migrate:

1. Remove the standalone package:
   ```bash
   dsh plugin --profile web remove dsh-quota-panel
   ```
2. Delete the `quota-panel` insert row from `$DSH_HOME/profiles/web/cordis.patch.yml`
   (the `id: quota-panel` entry and its `statusPath` config — that file is no longer read).
3. Restart dsh. The pill now reads `/autopilot/api/status` from
   `dsh-quota-autopilot`; the `statusPath` config key is obsolete.

## Uninstall

1. `dsh plugin --profile web remove dsh-quota-autopilot`
2. Delete the `insert` row from `$DSH_HOME/profiles/web/cordis.patch.yml`
3. Remove `~/.dsh/.agent-presets/auto/` (or run `node node_modules/dsh-quota-autopilot/scripts/uninstall.mjs --yes`)
4. Optionally delete the data directory (`<profile>/data/dsh-quota-autopilot/` or `~/.dsh/plugin-data/dsh-quota-autopilot/`)

No other residue.

## How routing advice works

1. **Rules** match on task type, estimated tokens, and quota conditions, producing role candidates with base scores (no match → the `fallback` role).
2. **Modifiers** add or subtract score from matched candidates when their quota/budget conditions fire (e.g. "weekly quota resets within 48 h → prefer spending subscription quota"; "daily spend over budget → downgrade non-critical tasks to `worker`").
3. Candidates are sorted by score; a **guardrail** walks them in order and skips any role that failed to resolve (unknown model or unconfigured provider) — a route is never invented.
4. Output: a `recommendation` (`{role, provider, model, reasoningEffort}`) plus `ruleId`, `score`, `why`, explanatory `notes`, the full `candidates` list, the current `quotaState`, and the calibration status (`learning` / `calibrated`).

## License

MIT — see [LICENSE](LICENSE).

---

# dsh-quota-autopilot（中文）

> 面向 dsh（DeepSeek Harness）的额度感知模型路由顾问。

## 功能

- **角色制路由顾问。** 路由只认四个角色——`main` / `worker` / `long-context` / `reviewer`——永不直接引用模型名。内置知识库登记已知 provider 的已知模型（`deepseek-official`：main = `deepseek-v4-pro`，worker = `deepseek-v4-flash`，reviewer = `deepseek-v4-pro`；`kimi-coding`：long-context = `k3`）。插件启动时探测各 provider 实际可用的模型，再按知识库填充角色。知识库不认识的模型一律不参与路由（防烧钱护栏），除非你在配置里显式把它映射到某个角色。provider 未配置时，`main` 回退到该 provider 的部署默认模型。
- **额度感知。** 按可配置间隔轮询 Kimi `/v1/usages` 与 DeepSeek `/user/balance`，把结果喂进五档状态机：`AGGRESSIVE` / `NORMAL` / `CONSERVE` / `RESERVE` / `EMERGENCY`。
- **数据新鲜度。** 每个额度值都附带逐来源新鲜度（`collectedAt` / `ageMs` / `stale`）。快照超过 `poll.staleAfterMin`（默认 15 分钟）即标记 stale 并从状态/路由决策中排除——但仍会显示，让你区分「无信号」与「信号正常」。DeepSeek 今日花费返回 `incomplete` + `unknownModels`，而不是把未知费率静默当 0。
- **GUI 额度胶囊（web profile）。** 在 composer 底部横带挂载只读胶囊，显示 Kimi 周/5h、DeepSeek 余额、今日花费、Codex（ChatGPT 订阅）与本地运行时（Ollama/LM Studio，∞），并带 stale 标记。由本插件自己的 `/autopilot/api/status` 路由提供——不再依赖外部状态文件。
- **自动标定。** 静默积累账户快照与逐请求归因数据；当采集跨度 ≥24 小时且额度点数净增 ≥3 时，自动产出**你自己账户的** tokens-per-point 折算率，并随新窗口数据滑动修正。标定完成前，凡涉及该折算率的输出一律标注 `learning`（学习中）——绝不瞎猜。
- **只建议，不动手。** 插件绝不改变实际路由；建议与实际消耗的对照写入本机 shadow 日志，供事后比对。

## 安装

### 从 GitHub 安装（推荐，无需 npm 账号）

```bash
dsh plugin --profile web add "github:Spencermona/dsh-quota-autopilot#v0.2.0"
```

`dsh plugin` 会把包规格透传给 pnpm，因此可以直接安装公开 GitHub 仓库；这条路径无论发布者还是安装者都不需要 npm 账号。**需要 pnpm**——`dsh plugin` 底层就是驱动 pnpm，安装前请确认 pnpm 已在 PATH 上。

### 从 npm 安装（等以后发布到 registry 后）

```bash
dsh plugin --profile web add dsh-quota-autopilot
```

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml`（即 `~/.dsh/profiles/web/cordis.patch.yml`）中加一行根级 insert：

```yaml
- insert:
    - id: autopilot
      name: 'dsh-quota-autopilot'
      # config: { dailyBudgetUsd: 5 }   # 可选覆盖
```

patch 文件被热监听，保存即生效；重启 dsh 也可以。

**Auto preset（可选）。** 把本包的 `presets/auto/` 目录复制到 `~/.dsh/.agent-presets/auto/`（或运行 `node node_modules/dsh-quota-autopilot/scripts/install.mjs` 代劳），然后在会话预设选择器里选 **Auto**。仅 Auto preset 会话会出现 `route_consult` 工具；其他 preset 对顾问侧零感知（只读额度服务仍全局可用）。⚠️ **安装顺序有讲究**：Auto preset 会等待宿主插件的 `autopilot` 服务——请先装插件、再拷 preset；顺序颠倒会导致 Auto preset 无法完成挂载。

## 配置

全部默认值在 `src/config.mjs`；通过 `cordis.patch.yml` 行的 `config` 覆盖任意项。主要配置键：

| 键 | 含义 | 默认值 |
| --- | --- | --- |
| `credentials.kimiKeyName` / `credentials.deepseekKeyName` | `$DSH_HOME/.credentials.yaml` 里 key 的**名字**——永远不是 key 本身 | `KIMI_CODING_API_KEY` / `DEEPSEEK_API_KEY` |
| `poll.intervalMin` | 额度轮询间隔（分钟） | `5` |
| `poll.staleAfterMin` | 快照超过该分钟数即视为过期，并从状态/路由决策中排除（仍会显示） | `15` |
| `poll.kimiUsageUrl` / `poll.deepseekBalanceUrl` / `poll.timeoutMs` | 查询端点与请求超时 | 见默认值 |
| `panel.*` | GUI 胶囊：`codex`/`local` 开关、`dailyCapUsd`、`lowPoints`/`warnPoints`、`warnBalanceUsd`/`lowBalanceUsd` 显示阈值 | 见默认值 |
| `dailyBudgetUsd` | DeepSeek 每日预算，供修饰器与状态机使用 | `5` |
| `calibration.minSpanHours` / `minPointDelta` / `driftRelearnPct` | 自动标定触发条件（跨度 ≥24h、点数净增 ≥3）与漂移重学阈值 | `24` / `3` / `30` |
| `roles` | 显式角色映射 `{provider, model, reasoningEffort?}`；未知模型进入路由的唯一途径 | `{}` |
| `rules` / `fallback` / `modifiers` / `stateMachine` / `stateActions` | 路由规则、加减分修饰器、额度状态机阈值——全部引用**角色名**，永不引用模型名 | 见 `src/config.mjs` |
| `dataDir` | 显式覆盖插件数据目录 | 自动解析 |

覆盖采用**深合并**语义：普通对象递归合并；**数组整体替换**（规则列表以整体为单位书写）。

插件同时注册了 settings 命名空间 `autopilot`，因此 `settings.yaml` 也可以在行配置之上叠加用户级覆盖。

## 数据源（透明性说明）

- **Kimi 额度** —— `GET https://api.kimi.com/coding/v1/usages`（复数）。⚠️ **该端点未文档化，随时可能变更。** 插件做防御性解析（字符串数字强转、NaN 容忍），schema 漂移时记录 `parse_error` 并告警，不崩溃。
- **DeepSeek 余额** —— `GET https://api.deepseek.com/user/balance`（官方文档化端点）。只有货币余额，没有 token 维度。
- **dsh 自身 durable 日志** —— `~/.dsh/sessions/**/session.jsonl.zstd`。这是逐请求真实 token 用量的唯一精确来源，插件对其**严格只读**。

### 网上公开数据能替代什么

公开文档可以安全地用来初始化模型名称、上下文长度、能力标签和公开 API 价格；但它**不能**真实替代你的账户剩余额度、刷新窗口、余额、实际 token 用量或个人 tokens-per-point 折算率。账户数据不可用时，插件会保持对应字段不可用或 `learning`，而不是编造数值；路由则退化为已解析角色与非额度规则。这是有意设计的保守降级。

## 隐私承诺

- 所有数据留在本机。一切写入限定在插件数据目录（`$DSH_HOME/profiles/` 下的 `<profile>/data/dsh-quota-autopilot/`，或回退到 `~/.dsh/plugin-data/dsh-quota-autopilot/`）。
- 核心额度轮询只访问上面的 Kimi 与 DeepSeek 端点。Web 面板的可选 Codex 显示默认开启，此时本机 Codex OAuth token 只会发送到 `https://chatgpt.com/backend-api/wham/usage`；设置 `panel.codex: false` 可关闭。本地运行时探测只访问回环地址上的 Ollama/LM Studio。
- API key 只从本机凭据存储**按名字**读取（key 名可配置）；任何配置文件里都不需要贴 key。所有日志与输出中，key 只显示前 4 位 + 后 4 位（例如 `sk-a****wxyz`）。

## 环境要求

- Node.js ≥ 22.15（使用原生 `node:sqlite` 模块）
- dsh（已用 `web` profile 验证）
- pnpm（GitHub 直装路线需要——`dsh plugin` 会把规格透传给 pnpm）
- Windows / macOS / Linux

## 升级与迁移

### 从 v0.1.0（本包）升级

1. 按新 tag 重装：
   ```bash
   dsh plugin --profile web add "github:Spencermona/dsh-quota-autopilot#v0.2.0"
   ```
2. Auto preset 未变；若早先拷贝过 `presets/auto/`，重新运行
   `node node_modules/dsh-quota-autopilot/scripts/install.mjs --force` 以同步变更。
3. web GUI 胶囊现已由本包自身提供（无需额外步骤）——client bundle 通过包的
   `dsh.client` 清单被发现，在 web profile 中自动挂载。

### 从独立 `dsh-quota-panel` 迁移

v0.2.0 用内建面板取代了旧的独立 GUI 包（旧包读取外部 `quota-status.json`）。
迁移步骤：

1. 卸载独立包：
   ```bash
   dsh plugin --profile web remove dsh-quota-panel
   ```
2. 删除 `$DSH_HOME/profiles/web/cordis.patch.yml` 中的 `quota-panel` insert 行
   （`id: quota-panel` 条目及其 `statusPath` 配置——该文件已不再被读取）。
3. 重启 dsh。胶囊现在从 `dsh-quota-autopilot` 读取 `/autopilot/api/status`；
   `statusPath` 配置键已废弃。

## 卸载

1. `dsh plugin --profile web remove dsh-quota-autopilot`
2. 删除 `$DSH_HOME/profiles/web/cordis.patch.yml` 中的 `insert` 行
3. 删除 `~/.dsh/.agent-presets/auto/`（或运行 `node node_modules/dsh-quota-autopilot/scripts/uninstall.mjs --yes`）
4. 可选：删除数据目录（`<profile>/data/dsh-quota-autopilot/` 或 `~/.dsh/plugin-data/dsh-quota-autopilot/`）

无其他残留。

## 路由建议原理

1. **规则**按任务类型、估算 token 数与额度条件匹配，产出带基础分的角色候选（无匹配时走 `fallback` 角色）。
2. **修饰器**在其额度/预算条件触发时对命中候选加减分（例如「周额度 48 小时内重置 → 优先消耗订阅额度」；「当日花费超预算 → 非关键任务降级到 `worker`」）。
3. 候选按分数排序，**护栏**依序跳过未能解析的角色（未知模型或未配置的 provider）——绝不凭空发明路由。
4. 输出：`recommendation`（`{role, provider, model, reasoningEffort}`）以及 `ruleId`、`score`、`why`、解释性 `notes`、完整 `candidates` 列表、当前 `quotaState` 与标定状态（`learning` / `calibrated`）。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
