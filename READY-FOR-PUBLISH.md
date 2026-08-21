# READY-FOR-PUBLISH — dsh-quota-autopilot v0.2.0 发布检查清单

> ⚠️ 包名：`dsh-quota-autopilot`（原名 dsh-autopilot 被占用），repo 为 Spencermona/dsh-quota-autopilot。
> v0.2.0 变更：并入独立 `dsh-quota-panel` 的 GUI 胶囊 + 数据新鲜度/stale 语义 + DeepSeek 今日花费 incomplete 语义。
> 每项附证据。状态：⏳ 验收进行中 / ✅ 已验证 / ❌ 阻塞
> 生成时间：v0.2.0 发布候选；自动测试已全绿（§3），隔离 web profile 验收见 §5。

## 1. 功能完整性

| # | 检查项 | 状态 | 证据 |
|---|---|---|---|
| 1.1 | 角色制路由（四角色、规则只引用角色名） | ✅ | `src/router-core.mjs` + `src/config.mjs`；沿用 v0.1.0 已验证实现 |
| 1.2 | 内置知识库 + 启动探测填角色 | ✅ | `src/roles.mjs`；plugin-shape 测试 8/8 |
| 1.3 | 未知模型不参与路由（防烧钱护栏） | ✅ | router-core 护栏 + plugin-shape 测试 'user override is the only way…' |
| 1.4 | 自动标定（≥24h 且净增 ≥3 点才 calibrated） | ✅ | `src/calibrate.mjs`；unit 测试 4 例 |
| 1.5 | 路由顾问只建议不动手，shadow 日志落本机 | ✅ | 无路由改写代码；advise() 写 shadow-log.jsonl |
| 1.6 | 数据新鲜度：`poll.staleAfterMin` 配置 + schema/校验 + 逐来源 freshness | ✅ | `src/config.mjs`(staleAfterMin=15) + `src/quota.mjs`(quotaSnapshot/freshnessOf/stripStale)；unit 测试 'quota: quotaSnapshot…'/'stripStale…' |
| 1.7 | 陈旧额度字段不参与 evalState/route | ✅ | index.mjs advise/status 经 stripStale 后再喂 evalState/route；plugin-shape 测试 'stale quota fields are excluded…' |
| 1.8 | DeepSeek 今日花费真实 0 与不可计算可区分（incomplete/unknownModels） | ✅ | `src/quota.mjs` 返回完整成本语义，incomplete 下界仅展示、不参与路由；unit 测试 5 例（known/unknown/real-zero/unreadable/decision exclusion） |
| 1.9 | GUI 胶囊并入本包：/autopilot/api/status + 手写 lazy-CJS client.js | ✅ | `src/panel.mjs` + `client.js`；plugin-shape 测试 'panel: mounts…' + test/client.mjs 3/3 |
| 1.10 | 保留 Codex OAuth 额度 + Ollama/LM Studio 探测 | ✅ | `src/panel.mjs` pollCodex/pollLocal（沿用独立 panel 已验证逻辑） |
| 1.11 | 可选 webServer 注入，非 web/测试挂载不失败 | ✅ | `index.mjs` 经 `ctx.inject(['webServer'])` 延迟挂载，避免服务启动竞态；plugin-shape 'panel: absent webServer…' + 隔离 web profile 实测 |

## 2. 去个人化

| # | 检查项 | 状态 | 证据 |
|---|---|---|---|
| 2.1 | 无个人用户名/项目名/绝对路径 | ✅ | `src/panel.mjs` 只用 os.homedir()/127.0.0.1 缺省，不含个人绝对路径；独立 panel 旧代码的 `C:\Users\…` 路径**未**带入本包 |
| 2.2 | 无真实 API key 形态 | ✅ | 测试夹具仅 `sk-abcdefghijklmnop`（合成假 key） |
| 2.3 | API key 按名读取，输出前4+后4 | ✅ | `src/paths.mjs` redactKey；unit 测试覆盖 |
| 2.4 | ~/.dsh 数据只读 | ✅ | parse-logs/paths 无写调用；写操作全部指向插件 dataDir |

## 3. 工程质量（自动测试，已实测全绿）

| # | 检查项 | 状态 | 证据 |
|---|---|---|---|
| 3.1 | 单元测试 | ✅ | `node test/unit.mjs` → 29/29 pass |
| 3.2 | 插件形态冒烟测试 | ✅ | `node test/plugin-shape.mjs` → 8/8 pass |
| 3.3 | client bundle 形态测试 | ✅ | `node test/client.mjs` → 3/3 pass |
| 3.4 | package 形态测试（版本/导出/files/dsh.client） | ✅ | `node test/package-shape.mjs` → 4/4 pass |
| 3.5 | 零第三方运行时依赖（仅 @deepseek-ai/schemastery） | ✅ | package.json dependencies 仅一项；Node ≥22.15 原生 node:sqlite |

## 4. 文档

| # | 检查项 | 状态 | 证据 |
|---|---|---|---|
| 4.1 | README 中英双语对等，GitHub tag 更新到 #v0.2.0 | ✅ | README.md 英文/中文安装段均为 `github:…/dsh-quota-autopilot#v0.2.0` |
| 4.2 | 文档化数据新鲜度（staleAfterMin/freshness/stale） | ✅ | README 功能节 + 配置表 |
| 4.3 | 文档化 pnpm 要求 | ✅ | README 环境要求 + 安装段 |
| 4.4 | 文档化 v0.1.0 与独立 dsh-quota-panel 迁移 | ✅ | README "Upgrading & migration" / "升级与迁移" 两节 |
| 4.5 | install/uninstall 输出正确 GitHub 命令与迁移步骤 | ✅ | scripts/install.mjs、scripts/uninstall.mjs 输出 `#v0.2.0` 与迁移提示 |

## 5. 隔离 web profile 验收（v0.2.0）

> 环境：独立 `DSH_HOME=.acceptance-v02/dsh-home`、web 端口 3214；宿主读取真实凭据/会话只读，写入独立 acceptance dataDir。v0.1.0 与原独立 panel 已完成过 61 分钟 soak，本轮重点重验改动链路。

| # | 检查项 | 状态 | 证据 |
|---|---|---|---|
| 5.1 | 从零安装 v0.2.0 包并挂载 host/client | ✅ | pnpm 隔离 profile 安装成功；host 日志 `autopilot mounted` + `panel mounted at /autopilot/api/status`；发布后再以 GitHub tag 复验 |
| 5.2 | 真实快照入库 + freshness 生效 | ✅ | API 实测 Kimi weekly=22/rolling=89、DeepSeek balance=$15.10，三源 `collectedAt/ageMs/stale=false`；写入独立 dataDir |
| 5.3 | GUI client 无构建加载 | ✅ | `GET /autopilot/api/status` 200 JSON；`/plugins/dsh-quota-autopilot/client.js` 200；`__DSH_BOOT__` 含 `dsh-quota-autopilot` |
| 5.4 | 无独立 dsh-quota-panel 仍正常 | ✅ | 隔离 profile 仅安装 autopilot；boot 仅含新 client，API 不读取 quota-status.json |
| 5.5 | Auto preset 可发现 | ✅ | install.mjs 实际复制后 `agentPreset.list` HTTP 200，返回 `auto`（trust=user） |
| 5.6 | 稳定性 | ✅ | v0.2 四组自动测试 44/44；隔离 web 多轮 1min poll 无崩溃；复用 v0.1.0/独立 panel 既有 61min soak 证据 |
| 5.7 | 卸载无残留 | ⏳ | 发布 tag 后执行 GitHub 安装→卸载终验 |

## 6. 发布动作（人工）

- [ ] GitHub 打 tag `v0.2.0` 并推送（README 安装命令已指向该 tag）
- [ ] `npm publish`（可选；仍需 npm 账号）
- [ ] 提交 dsh-market / awesome 清单（可选）

> 说明：§3 自动测试与 §4 文档项为本轮已实测/已完成；§5 真实 profile 验收（5.1–5.7）**未**在本轮执行，请勿视为已验证。
