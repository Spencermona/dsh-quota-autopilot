# READY-FOR-PUBLISH — dsh-autopilot v0.1.0 发布检查清单

> ⚠️ 2026-08-20 改名：npm 包名由 dsh-autopilot 更名为 dsh-quota-autopilot（原名被占用），repo 为 Spencermona/dsh-quota-autopilot。

> 每项附证据。状态：⏳ 验收进行中 / ✅ 已验证 / ❌ 阻塞
> 生成时间：2026-08-19；验收已于当日完成（§5 全部实测通过）

## 1. 功能完整性

| # | 检查项 | 状态 | 证据 |
|---|---|---|---|
| 1.1 | 角色制路由：四角色 main/worker/long-context/reviewer，规则只引用角色名 | ✅ | `src/router-core.mjs`（`ROLES` 导出、route() 按角色解析）；`src/config.mjs` rules/modifiers 全部 role 引用 |
| 1.2 | 内置知识库 + 启动探测填角色 | ✅ | `src/roles.mjs` KNOWLEDGE_BASE + resolveRoles（listProviders/listModels 门控）；plugin-shape 测试 5/5 |
| 1.3 | 未知模型不参与路由（防烧钱护栏），用户显式映射是唯一例外 | ✅ | router-core.mjs 不可解析角色跳过逻辑；plugin-shape 测试 'user override is the only way an unknown model enters routing' |
| 1.4 | provider 未配置时 main 回退部署默认模型 | ✅ | roles.mjs Priority 3（agentDefaultModel.currentSelection）；plugin-shape 测试 'default-model fallback fills main' |
| 1.5 | 自动标定：≥24h 且净增 ≥3 点才 calibrated，此前一律 learning | ✅ | `src/calibrate.mjs` 显式门槛；unit 测试 'calibrate: learning -> calibrated with explicit gates' 等 4 例 |
| 1.6 | 路由顾问只建议不动手，shadow 日志落本机 | ✅ | 全仓无 agent/request 改写、无 saveSelection 调用；advise() 写 shadow-log.jsonl（plugin-shape 测试验证） |
| 1.7 | Auto preset 仅其会话启用顾问，其他 preset 零感知 | ✅ | 结构性：advisor 行只在 presets/auto/agent.cordis.yml；运行时：auto 会话创建成功且 roster 无 broken，standard 会话正常，卸载后 roster 恢复原样（§5.3/5.4/5.7） |

## 2. 去个人化

独立审计 agent 全仓复核（排除 node_modules/.npm-cache/package-lock.json），结论全部通过：

| # | 检查项 | 状态 | 证据 |
|---|---|---|---|
| 2.1 | 无个人用户名/项目名/绝对路径 | ✅ | 全仓 grep 红线词表（词表带外维护，不落盘于本仓库；含用户名/个人项目名/用户目录绝对路径形态，大小写敏感+整词）零命中；路径全部经 DSH_HOME/os.homedir/import.meta.url 解析 |
| 2.2 | 无真实 API key 形态 | ✅ | `sk-[A-Za-z0-9]{8,}` 仅命中 test/unit.mjs:34 的合成夹具 `sk-abcdefghijklmnop`（连续字母假 key，用于断言 redactKey），无真实 key |
| 2.3 | API key 按名读取（credentials 服务优先，文件降级），输出前4+后4 | ✅ | `index.mjs` resolveKeys（服务优先+catch 降级）+ `src/paths.mjs` redactKey；unit 测试 'redactKey: all branches' |
| 2.4 | ~/.dsh 数据全程只读 | ✅ | parse-logs/paths 无任何写调用；写操作全部指向插件 dataDir（审计逐文件确认） |
| 2.5 | .gitignore 排除 credentials/key/测试产物/依赖产物 | ✅ | `.gitignore`（node_modules、.npm-cache、.credentials.yaml、*.key、secrets、test-profile） |
| 2.6 | 只建议不动手（无路由改写代码） | ✅ | 全仓 grep saveSelection/agent/request waterfall：源码零命中；advisor 只注册工具 + prompt section |

## 3. 工程质量

| # | 检查项 | 状态 | 证据 |
|---|---|---|---|
| 3.1 | 单元测试全绿 | ✅ | `node test/unit.mjs` → 21/21 pass |
| 3.2 | 插件形态冒烟测试全绿 | ✅ | `node test/plugin-shape.mjs` → 5/5 pass |
| 3.3 | Kimi 端点防御性解析 + 失效告警 | ✅ | `src/poll.mjs`：parse_error 行 + WARN 不崩溃；unit 测试覆盖 schema 漂移/fetch 失败 |
| 3.4 | 零第三方运行时依赖（仅 @deepseek-ai/schemastery，npm 可装） | ✅ | package.json dependencies 仅一项；Node ≥22.15 原生 node:sqlite |
| 3.5 | MIT 许可证 | ✅ | LICENSE |

## 4. 文档

| # | 检查项 | 状态 | 证据 |
|---|---|---|---|
| 4.1 | README 中英双语对等 | ✅ | README.md（英文 1-93，中文 97-182） |
| 4.2 | 数据源透明 + Kimi 端点未文档化风险声明 | ✅ | README "Data sources" 节 ⚠️ 标注 |
| 4.3 | 隐私承诺（数据不出本机） | ✅ | README "Privacy" 节 |
| 4.4 | 安装/卸载步骤与机制一致 | ✅ | 审计比对：README insert 行与 install.mjs 打印片段逐字一致；卸载 4 步与 uninstall.mjs 输出一致；安装顺序警告已补（Auto preset 依赖宿主插件） |

## 5. 全新测试 profile 验收（实测完成，2026-08-19）

环境：独立 `DSH_HOME=<workspace>/.acceptance/dsh-home`（真实 ~/.dsh 全程未动，仅只读复制 credentials.yaml 供轮询），`dsh --profile web --port 3211/3212`，真实 Kimi/DeepSeek 端点。

| # | 检查项 | 状态 | 证据 |
|---|---|---|---|
| 5.1 | 按 README 从零安装成功 | ✅ | profile node_modules 装包 + cordis.patch.yml insert 行后，启动日志 `[autopilot] mounted, dataDir=.../profiles/web/data/dsh-autopilot`（数据目录自定位约定在真实 profile 下验证成立） |
| 5.2 | 快照入库正常 | ✅ | ledger.db `account_snapshots` 首周期即 7 行（kimi weekly used=37/remaining=63 + deepseek balance 22.29 USD 真实数据）；soak 全程持续增长至 441 行；四类 Kimi 窗口 + 三类 DeepSeek 行齐全（poll.intervalMin=1 加速） |
| 5.3 | Auto preset 出现且可选 | ✅ | `agentPreset.list` 返回 auto（trust=user、双语 name/description、无 broken）；`session.create {agentPreset:'auto'}` → `ok:true`（session-474efa3f / 修复后复验 session-256b4fad）；standard↔auto 双向 `agentPreset.select` 均 ok |
| 5.4 | 其他 preset 无感知 | ✅ | standard 会话创建成功（session-933e4c88）；4 个 system preset 组合文件 grep `autopilot|route_consult` 零匹配；advisor 行仅存在于 auto preset；卸载后 roster 恢复 standard/code/minimal/cordis 四项 |
| 5.5 | 未知模型不参与路由 | ✅ | plugin-shape 测试 'user override is the only way an unknown model enters routing' + 'degraded mode: recommended=null 绝不发明路由'；router-core 护栏单测（不可解析角色按分跳过） |
| 5.6 | 1 小时 soak | ✅ | 连续运行 **61 分钟**（16:31:35Z→17:32:35Z），account_snapshots 检查点 53→123→193→263→331→441 行（修复重启后续跑至 462 行），web 全程 HTTP 200，3 次瞬时网络故障记 fetch_error 行无崩溃；逐 10 分钟证据存于验收工作区 `soak-log.jsonl`（随验收环境保留，不进仓库） |
| 5.7 | 卸载无残留 | ✅ | README 四步卸载后四项删除复核全部净除；重启实例：HTTP 200、日志零 autopilot 报错、roster 回落 4 个 system preset、standard 会话创建 ok（验收 agent 与主会话两轮独立复核） |

**验收期发现的唯一缺陷及处置**：advisor.mjs `inject` 漏声明 `tools`（首轮 Auto 挂载报 `cannot get property "tools" without inject`）。根因 = mock ctx 不强制 inject 声明。修复（inject 补 'tools' + 断言更新）后真实实例复验通过。

## 6. 发布动作（人工）

- [x] GitHub 公开仓库：`Spencermona/dsh-quota-autopilot`
- [x] package.json 已补 `repository` / `bugs` / `homepage`
- [x] Git 仓库、首次提交与 GitHub `main` 推送
- [x] 无 npm 账号的发布路径：支持 `dsh plugin --profile web add "github:Spencermona/dsh-quota-autopilot#v0.1.0"`
- [ ] GitHub 仓库 topic：`dsh-plugin`（网页端操作，可选）
- [ ] `npm publish`（可选；不再阻塞 v0.1.0，未来有 npm 发布账号后补）
- [ ] 提交 dsh-market / awesome 清单（可选）
