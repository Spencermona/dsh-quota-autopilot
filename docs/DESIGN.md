# dsh-quota-autopilot 设计文档（实现契约）

> 状态：草案 v1（待调研报告回填 API 细节，标记为 ⏳ 的小节）
> 本文档是实施子 agent 的权威依据。任何与任务书冲突的改动必须先改本文档。

## 0. 定位

把个人版额度账本 + 路由顾问 + 标定工具链产品化为 dsh 社区插件。
**顾问制**：只建议、不动手。绝不改变实际路由；建议 vs 实际消耗对照写入用户本地 shadow 日志。

- npm 包 / GitHub repo 名：`dsh-quota-autopilot`，topic `dsh-plugin`
- v0.1 纯 host 插件：cordis service + settings namespace，无浏览器 UI
- 附带 agent preset `Auto`：仅 Auto preset 会话启用路由顾问，其他 preset 零感知
- 安装路径与 dsh-plugin-turn-notify 相同：profile `node_modules` + `cordis.patch.yml` insert

## 1. 包结构

```
dsh-quota-autopilot/
  package.json            # name: dsh-quota-autopilot, type: module
  LICENSE                 # MIT
  README.md               # 中英双语
  index.mjs               # host 插件入口（cordis plugin export）
  advisor.mjs             # Auto preset 用的顾问工具行入口（同包第二个导出/文件）
  src/
    config.mjs            # 默认配置 + 深合并 + 校验
    paths.mjs             # DSH_HOME 自动探测、credentials 读取、key 脱敏
    poll.mjs              # Kimi /v1/usages + DeepSeek /user/balance（防御性解析）
    ledger.mjs            # node:sqlite 快照+归因存储（插件数据目录）
    calibrate.mjs         # 自动标定（≥24h 且 Δ点≥3 → tok/pt，滑动修正）
    roles.mjs             # 角色知识库 + 启动探测 + 角色解析
    router-core.mjs       # 规则引擎（移植自个人原型，routes 改为角色引用）
    state.mjs             # 五档额度状态机（AGGRESSIVE/NORMAL/CONSERVE/RESERVE/EMERGENCY）
    shadow.mjs            # shadow 日志（建议 vs 实际）JSONL
  presets/auto/
    agent.cordis.yml      # 基于 standard 拷贝 + 追加 advisor 行
    preset.yml            # name: Auto, description
  scripts/
    install.mjs           # 可选：拷贝 preset + 打印 patch 片段（不自动改用户配置）
    uninstall.mjs         # 可选：反向指引
  READY-FOR-PUBLISH.md    # 发布检查清单（验收后产出）
  docs/DESIGN.md          # 本文档
```

## 2. 角色制模型路由（核心）

Router 只认四个角色：`main` / `worker` / `long-context` / `reviewer`。

### 2.1 内置模型知识库（src/roles.mjs）

```js
const KNOWLEDGE_BASE = {
  'deepseek-official': {
    main: 'deepseek-v4-pro',
    worker: 'deepseek-v4-flash',
    reviewer: 'deepseek-v4-pro',
  },
  'kimi-coding': {
    'long-context': 'k3',
  },
}
```

### 2.2 角色解析顺序（每个角色）

1. 用户配置 `roles.<role>` 显式映射（`{provider, model, reasoningEffort?}`）——最高优先，允许映射任何模型（含知识库不认识的）
2. 知识库：provider 存在且该模型在**启动探测结果**中实际可用 → 填入角色
3. `main` 角色兜底：provider 未配置时回退到该 provider 的**部署默认模型**（⏳ agentDefaultModel 服务）
4. 仍无法解析 → 该角色不可用，顾问输出中如实标注

### 2.3 防烧钱护栏

- 知识库不认识的模型**一律不参与 Auto 路由**——即使它出现在 provider 的可用模型列表里
- 唯一例外：用户在配置里显式 `roles.<role>` 映射了它
- 路由规则（rules/modifiers）引用的是**角色名**，永远不直接引用模型名

### 2.4 规则引擎改造（相对个人原型）

- `router.config.json` 的 `routes` 表（硬编码 provider/model）→ 角色名：`flash→worker`、`pro-high→worker? 不`——映射如下：
  - `batch-simple` → `worker`
  - `long-context` → `long-context`
  - `vision` → `long-context`（K3 支持视觉；角色语义不变）
  - `review` → `reviewer`
  - `coding-main` → `main`
  - fallback → `main`
- 规则/修饰器/状态机结构原样保留，全部进插件默认配置
- 推荐输出结构：`{role, provider, model, reasoningEffort, ruleId, score, why, notes[], candidates[]}`

## 3. 额度状态机（移植，参数进默认配置）

五档：AGGRESSIVE / NORMAL / CONSERVE / RESERVE / EMERGENCY。
判定输入：kimiWeeklyRemaining(+Pct/Limit/ResetTime)、kimiRolling5hRemaining、
deepseekBalanceUsd、deepseekTodayUsd（按费率表从归因 token 折算）。
阈值默认值 = 现 router.config.json 的 stateMachine/stateActions。

## 4. 自动标定模块

- 插件静默积累：账户快照（poll）+ 归因 token（dsh durable 日志解析，移植 lib/parse-logs.mjs 的只读部分）
- 触发条件：采集跨度 ≥24h **且** weekly 点数净增 ≥3 → 首次产出 tok/pt
- 之后每次新窗口数据满足条件 → 滑动修正（宏观比率 = Σ(in+out token) / ΣΔ点，全窗口累计；漂移 >30% 时更新配置缓存值并记录）
- 标定完成前：凡涉及点数↔token 折算的输出一律标注 `learning: true`（"学习中"），**不瞎猜**——顾问仍可用点数原始值与状态机工作（状态机阈值本来就是点数为单位的）
- 标定数据存插件目录 `calibration.json`：`{status: 'learning'|'calibrated', tokPerPoint, sampleWindows, spanHours, updatedAt, history[]}`

## 5. 路由顾问（只建议，不动手）

### 5.1 两个面

- **host 插件行**（cordis.patch.yml insert）：轮询 + 账本 + 标定 + 角色解析 + `autopilot` service（⏳ 服务名/形状待调研）。对所有 preset 提供只读额度数据，但**不注册任何模型工具** → 其他 preset 零感知
- **advisor 行**（仅 Auto preset 的 agent.cordis.yml 引用同包 `advisor.mjs`）：注册模型工具 `route_consult({task, type, estTokens?})` → 返回路由建议 JSON；写 shadow 日志。该行走 host 服务消费位，不发布服务，无需 isolate realm

### 5.2 shadow 日志

`<插件数据目录>/shadow-log.jsonl`，每行：
```json
{"ts":..., "kind":"advice", "task":"...", "type":"coding", "estTokens":...,
 "recommendation":{"role":"main","provider":"...","model":"..."},
 "quotaState":"NORMAL", "calibration":"learning|calibrated", "sessionId":"..."}
```
对照侧（实际消耗）由账本归因层按 sessionId 关联，事后可读。**插件绝不调用任何改变路由的 API。**

### 5.3 会话报告

route_consult 工具输出即会话内可见的建议记录（tool output 进会话）；Auto preset 的 system prompt 段落（⏳ 实现方式：preset 里加 prompt 行）指示 agent「派 subagent/大任务前先调 route_consult」。

## 6. 去个人化（验收红线）

- 路径：`paths.mjs` 统一解析 `process.env.DSH_HOME ?? join(os.homedir(), '.dsh')`；可用配置 `dshHome` 覆盖。代码与文档中**禁止**出现任何用户目录绝对路径字面量
- 个人特征：全仓 grep 红线词（用户名、个人项目名、个人工作区名——词表由审计任务带外提供，不落盘于本仓库）
- API key：仅从 `$DSH_HOME/.credentials.yaml` 按 key 名读取（key 名可配置：`credentials.kimiKeyName` / `credentials.deepseekKeyName`，默认 `KIMI_CODING_API_KEY` / `DEEPSEEK_API_KEY`）。YAML 用最小手写解析（key: value 行）避免依赖。**任何日志/输出中 key 只留前 4 + 后 4**（`redact()` 单测覆盖）
- 配置：阈值/预算/路由规则/知识库全部在 `src/config.mjs` 默认值，用户经 cordis.patch.yml 行 config 覆盖
- git：公开仓库零 key/零个人路径/零个人数据；`.gitignore` 排除 credentials 与测试 profile

## 7. 工程约束

- 对 `$DSH_HOME` 数据文件（sessions、credentials、settings）**全程只读**
- 插件数据目录：`<profile 目录>/data/dsh-quota-autopilot/`（⏳ 待确认 profile 目录解析 API），全部写入限定于此
- 网络：Node fetch（OpenSSL，规避 Schannel 限制）；Kimi `/v1/usages` 防御性解析（字符串数字 → Number，NaN 容忍；schema 漂移 → parse_error 记录 + 告警，不崩溃）；DeepSeek `/user/balance` 同理
- Node ≥22.15（`node:sqlite` 原生）；零 npm 运行时依赖
- MIT；README 中英双语：数据源、风险（Kimi 端点未文档化，可能变更）、隐私承诺（数据不出本机）、安装/卸载

## 8. 验收（READY-FOR-PUBLISH.md 证据项）

1. 全新测试 profile（`DSH_HOME=<临时目录>`）按 README 从零安装成功
2. 测试 profile 跑 1 小时：快照入库正常、Auto preset 出现且可选、其他 preset 无感知、未知模型不参与路由
3. 卸载无残留（删 patch 行 + node_modules 包 + preset 目录 + 数据目录后可正常启动）
4. 去个人化 grep 红线全过

## 10. v0.2+ 候选（本次不做）

- 账本保留策略：`account_snapshots`（含 raw_json）当前无限增长，v0.2 加裁剪（如保留 30 天 + 聚合层）
- 标定的请求次数底噪研究（个人原型 CALIBRATION 遗留问题）

## 9. 已确认的 dsh API 事实（2026-08-19 调研回填，证据见括号）

### 9.1 安装与分发
- profile = `$DSH_HOME/profiles/<name>/`，含 `package.json`（树外插件 dependencies）+ `cordis.patch.yml`（`dsh-app-boot/README.md:38`）
- patch 语法（`dsh-app-boot/lib/index.js:57-104`）：顶层 YAML 数组；根级插入 `- insert: [{id, name, config}]`（patch 自身无 id）；id 定向 patch 整字段替换 config；`disabled: true` 删除行；两层均热重载（`profile-boot-DG5t9aNs.js:264-273`）
- 包解析：`healProfilesModuleFallback` 维护扁平 `$DSH_HOME/profiles/node_modules` 符号链接（`dsh-app-boot/README.md:38`）；安装命令 `dsh plugin --profile web add <pkg>`（`dsh/lib/plugin-*.js:101-127`）
- 插件入口约定（样例 dsh-persona）：纯 ESM `"type":"module"`，命名导出 `name` / `inject` / `Config`（schemastery schema，可选）/ `apply(ctx, config)`

### 9.2 运行期服务（`dsh-tool-cordis/lib/index.js` 服务目录）
- `ctx.llm.listProviders()` → `LlmProviderInfo[]{id,name}`（行 1224）；`ctx.llm.listModels(provider)` → `Promise<LlmModelInfo[]{provider,id,name,...}>`（行 4730 LlmRuntime 声明）
- `ctx.agentDefaultModel.currentSelection()` → `{provider, model, reasoning?}`（行 21-37）
- `ctx.tools.register(definition)` → disposer；ToolDefinition = `{name, description, parameters, output, execute(args, exec), ...}`（行 2970, 5769）
- `ctx.timer.interval(cb, ms)` / `timeout` → disposer（行 2868-2902）；或 quota-mgr 式 `ctx.effect` + 原生 setInterval
- `ctx.settings.register(ns, schemasterySchema)` → SettingsScope（行 2167-2199）；settings namespace 用 `autopilot`
- `ctx.get('launchEnvironment').get('DSH_HOME')` → `{value, source}` 分层环境快照（`dsh-launch-environment/lib/index.js:56-67`）

### 9.3 插件数据目录解析（自定位约定）
插件包安装在 `$DSH_HOME/profiles/<profile>/node_modules/dsh-quota-autopilot/` → 从 `import.meta.url` 上溯两级即 profile 目录 → 数据目录 = `<profile>/data/dsh-quota-autopilot/`。若自定位不含 `profiles/<name>/node_modules` 形态（如全局安装），回退 `<dshHome>/plugin-data/dsh-quota-autopilot/`。可用 config `dataDir` 显式覆盖。

### 9.4 preset 分发
扫描根 = config.roots + 派生 `<dshHome>/.agent-presets`（`dsh-agent-presets/lib/index.js:146,160,851-854`）；目录 = preset（`agent.cordis.yml` + 可选 `preset.yml` 的 name/description）。**npm 包无法自动附带 preset**——README 引导用户复制 `presets/auto/` 到 `~/.dsh/.agent-presets/auto/`（`scripts/install.mjs` 可选代劳）。⚠️ preset 行里的裸包名从 **host 组合的 baseUrl（profile 目录）** 解析，不从 preset 目录解析（`dsh-agent-presets/README.md:63-69`）——Auto preset 的 advisor 行用 `name: 'dsh-quota-autopilot/advisor'`，插件装进 profile node_modules 后即可解析；相对路径才相对于 preset 目录。

### 9.5 settings namespace
约定：ns = 小写 kebab-case 插件 id（`dsh-settings/lib/index.js:81-90`）→ 我们注册 `autopilot`；`ctx.inject(['settings'], ...)` 可选注入（无 provider 时退回纯行 config）；分层 = schema 默认 < 行 config base < settings.yaml 用户段；敏感字段用 `role('secret')`（`dsh-settings/README.md:12,44`）。schema 用 schemastery（host 侧可解析，内建包闭包经 healProfilesModuleFallback 链接进 profiles/node_modules）。

### 9.6 官方安装命令
`dsh plugin --profile web add dsh-quota-autopilot`（`dsh/lib/plugin-*.js:101-127`，pnpm 转发器，装到 profile node_modules）；普通插件再在 `cordis.patch.yml` 手写根级 `- insert: [{id: autopilot, name: 'dsh-quota-autopilot'}]`。README 以此为准。

### 9.7 credentials（双路径，服务优先）
**主路径** = 官方 credentials 服务（其实现 dsh-credentials-local 正是读 `$DSH_HOME/.credentials.yaml`）：`ctx.get('credentials')?.resolve(keyName)`，key 名来自 config（`credentials.kimiKeyName`/`deepseekKeyName`，可配）。**降级路径** = 服务缺席时 src/paths.mjs 的 readCredentials 只读解析同一文件。两条路径输出都经 redactKey（前4+后4）。证据：`dsh-credentials-local/lib/index.js:13-20,49-58`；官方消费样例 `dsh-llm-deepseek/lib/index.js:748-756`。

### 9.8 其他确认
- schemastery 包名 = `@deepseek-ai/schemastery`（Config schema 用；声明为 **dependencies**——保证 `dsh plugin add` 安装后即可解析，比 healed 链接兜底更稳；已经审计追认）
- 定时器 = `ctx.setInterval`（cordis-plugin-timer，boot 兜底保证，fiber 卸载自动清理）
- 工具 schema = dsh-tools 值 schema DSL（非 JSON Schema/zod）；输出必须 `{schema, render}`
- prompt 注入 = `ctx.systemPrompt.section({name, order, text})`（advisor 行用，Auto preset 无需手改 prompt）
- ⚠️ 禁止 `session.append` 自定义事件类型（回放会拒读）；会话内报告走工具输出
- 真实安装先例：本机 `profiles/web/cordis.patch.yml:7-9` 即 dsh-plugin-turn-notify 的根级 insert 行——README 片段照此形态
