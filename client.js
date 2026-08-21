// dsh-quota-autopilot — browser bundle (hand-written, no build step).
// Format follows the DSH lazy-CJS module system: window.__ModuleLoader__.load
// registers a factory; "react" is a platform module seeded by the shell
// (same pattern as dsh-agent-pill / dsh-client-ui-brand-official bundles).
//
// UI: a centered status pill in the `conversation.composer.dock` slot, one
// colored dot per provider. Metrics read as "remaining" (percent LEFT, never
// "used"); labels follow the active UI locale (zh/en) via the `locale`
// service. Providers: Kimi (week/5h), DeepSeek balance, daily cost, Codex
// (ChatGPT subscription, host-polled), local runtimes (Ollama/LM Studio, ∞).
// Polls the host plugin's /autopilot/api/status route (served by src/panel.mjs).
window.__ModuleLoader__.load({
	id: "dsh-quota-autopilot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var e = React.createElement;

		/** Services required before mounting (provided by the client runtime). */
		var inject = ["slots"];

		var POLL_MS = 30000;
		var GREEN = "#3fb950";
		var YELLOW = "#d29922";
		var RED = "#f85149";
		var GRAY = "#8b949e";

		var TEXT = {
			zh: {
				week: function (pct) { return "Kimi 周剩 " + pct; },
				fiveH: function (pct) { return "5h 剩 " + pct; },
				ds: function (usd) { return "DS 余 " + usd; },
				cost: function (usd) { return "今日花费 " + usd; },
				codexWeek: function (pct) { return "Codex 周剩 " + pct; },
				codexHours: function (h, pct) { return "Codex " + h + "h 剩 " + pct; },
				codexOut: "Codex 已尽",
				codexUnknown: "Codex —",
				local: "本地 ∞",
				stale: "过期",
				loading: "额度 …",
				loadError: "额度读取失败，重试中",
				unavailable: "额度不可用",
				tipTitle: "AI 额度（Kimi/DS 由 autopilot 轮询）",
				tipWeek: function (r, l, t) { return "Kimi 周额度：剩余 " + r + "/" + l + " 点，重置于 " + t; },
				tip5h: function (r, l) { return "Kimi 5h 窗口：剩余 " + r + "/" + l + " 点"; },
				tipUpdated: function (t) { return "更新于：" + t; },
				tipStale: "（数据过期，autopilot 轮询可能未运行）",
				tipSourceStale: "（数据过期）",
				tipCostIncomplete: function (m) { return "今日花费不完整：缺少费率 " + m; },
				tipErrors: function (x) { return "轮询错误：" + x; },
				tipCodexPlan: function (p) { return "Codex 套餐：" + p; },
				tipCodexWin: function (label, used, reset) { return "Codex " + label + "：已用 " + used + "%" + (reset ? " · 重置于 " + reset : ""); },
				tipCodexSpark: function (a, b) { return "Codex Spark：5h 已用 " + a + "% · 周已用 " + b + "%"; },
				tipCodexCredits: function (b) { return "Codex credits 余额：" + b; },
				tipCodexError: function (x) { return "Codex 查询失败：" + x; },
				tipOllama: function (n) { return "Ollama：运行中 · " + n + " 个模型"; },
				tipLmstudio: function (n) { return "LM Studio：运行中 · " + n + " 个模型"; },
				winWeek: "周窗口",
				winDay: "日窗口",
				winHours: function (h) { return h + "h 窗口"; },
				na: "—",
			},
			en: {
				week: function (pct) { return "Kimi wk " + pct + " left"; },
				fiveH: function (pct) { return "5h " + pct + " left"; },
				ds: function (usd) { return "DS " + usd + " left"; },
				cost: function (usd) { return "Today " + usd + " spent"; },
				codexWeek: function (pct) { return "Codex wk " + pct + " left"; },
				codexHours: function (h, pct) { return "Codex " + h + "h " + pct + " left"; },
				codexOut: "Codex exhausted",
				codexUnknown: "Codex —",
				local: "Local ∞",
				stale: "stale",
				loading: "quota …",
				loadError: "quota read failed, retrying",
				unavailable: "quota unavailable",
				tipTitle: "AI quota (Kimi/DS polled by autopilot)",
				tipWeek: function (r, l, t) { return "Kimi weekly: " + r + "/" + l + " points left, resets " + t; },
				tip5h: function (r, l) { return "Kimi 5h window: " + r + "/" + l + " points left"; },
				tipUpdated: function (t) { return "Updated: " + t; },
				tipStale: " (stale — autopilot polling may not be running)",
				tipSourceStale: " (stale)",
				tipCostIncomplete: function (m) { return "Today cost incomplete: missing rate for " + m; },
				tipErrors: function (x) { return "Poll errors: " + x; },
				tipCodexPlan: function (p) { return "Codex plan: " + p; },
				tipCodexWin: function (label, used, reset) { return "Codex " + label + ": " + used + "% used" + (reset ? " · resets " + reset : ""); },
				tipCodexSpark: function (a, b) { return "Codex Spark: 5h " + a + "% used · week " + b + "% used"; },
				tipCodexCredits: function (b) { return "Codex credits balance: " + b; },
				tipCodexError: function (x) { return "Codex query failed: " + x; },
				tipOllama: function (n) { return "Ollama: running · " + n + " models"; },
				tipLmstudio: function (n) { return "LM Studio: running · " + n + " models"; },
				winWeek: "weekly window",
				winDay: "daily window",
				winHours: function (h) { return h + "h window"; },
				na: "—",
			},
		};

		function dotForPoints(remaining, panel) {
			if (typeof remaining !== "number") return GRAY;
			if (remaining < (panel.lowPoints || 10)) return RED;
			if (remaining < (panel.warnPoints || 25)) return YELLOW;
			return GREEN;
		}
		function dotForBalance(usd, panel) {
			if (typeof usd !== "number") return GRAY;
			if (usd < (panel.lowBalanceUsd || 1)) return RED;
			if (usd < (panel.warnBalanceUsd || 5)) return YELLOW;
			return GREEN;
		}
		function dotForPercentLeft(pct) {
			if (typeof pct !== "number") return GRAY;
			if (pct < 10) return RED;
			if (pct < 25) return YELLOW;
			return GREEN;
		}
		function fmtUsd(n) {
			return typeof n === "number" ? "$" + (n >= 100 ? n.toFixed(0) : n.toFixed(2)) : null;
		}
		function fmtPct(remaining, limit) {
			if (typeof remaining !== "number" || typeof limit !== "number" || limit <= 0) return null;
			return Math.round((remaining / limit) * 100) + "%";
		}
		function fmtTime(ms) {
			return typeof ms === "number" ? new Date(ms).toLocaleString() : null;
		}
		function dot(color) {
			return e("span", {
				style: {
					width: 6,
					height: 6,
					borderRadius: "50%",
					background: color,
					boxShadow: "0 0 4px " + color,
					flexShrink: 0,
				},
			});
		}
		function metric(key, color, text) {
			return e("span", {
				key: key,
				style: { display: "inline-flex", alignItems: "center", gap: 5 },
			}, dot(color), e("span", { style: { opacity: 0.78 } }, text));
		}
		// Pick a short label for a rate-limit window by its length.
		function windowLabel(T, seconds) {
			if (typeof seconds !== "number") return T.winHours("?");
			if (seconds >= 604800) return T.winWeek;
			if (seconds >= 86400) return T.winDay;
			return T.winHours(Math.round(seconds / 3600));
		}

		// The locale service publishes immutable snapshots (uSES-safe); fall back
		// to the browser language when the service is absent.
		function useIsZh(localeService) {
			const snap = React.useSyncExternalStore(
				localeService ? localeService.subscribe.bind(localeService) : function () { return function () {}; },
				localeService ? localeService.getSnapshot.bind(localeService) : function () { return null; }
			);
			const id = String((snap && (snap.id || snap.locale || snap.tag)) || (typeof navigator !== "undefined" ? navigator.language : "en"));
			return id.toLowerCase().indexOf("zh") === 0;
		}

		function QuotaDock(props) {
			const isZh = useIsZh(props.localeService);
			const T = isZh ? TEXT.zh : TEXT.en;
			const [state, setState] = React.useState({ status: null, error: null });
			React.useEffect(() => {
				let dead = false;
				async function load() {
					try {
						const r = await fetch("/autopilot/api/status", { cache: "no-cache" });
						if (!r.ok) throw new Error("http " + r.status);
						const j = await r.json();
						if (!dead) setState({ status: j, error: null });
					} catch (err) {
						if (!dead) setState((s) => ({ status: s.status, error: String((err && err.message) || err) }));
					}
				}
				load();
				const t = setInterval(load, POLL_MS);
				const onFocus = () => load();
				window.addEventListener("focus", onFocus);
				return () => { dead = true; clearInterval(t); window.removeEventListener("focus", onFocus); };
			}, []);

			const s = state.status;
			if (!s) {
				return e("span", { style: { opacity: 0.5, fontSize: 11 } }, state.error ? T.loadError : T.loading);
			}
			const panel = s.panel || {};
			const kimi = s.kimi || null;
			const deepseek = s.deepseek || null;
			const cost = s.cost || {};
			const codex = s.codex || null;
			const local = s.local || null;
			const sourceStale = Boolean(
				(kimi && ((kimi.weekly && kimi.weekly.stale) || (kimi.rolling5h && kimi.rolling5h.stale))) ||
				(deepseek && deepseek.stale)
			);
			const stale = sourceStale || (typeof s.updatedAt === "number" && (Date.now() - s.updatedAt) > (panel.staleMs || 900000));
			const overCap = typeof cost.todayUsd === "number" && cost.todayUsd > (panel.dailyCapUsd || 2);

			const titleLines = [T.tipTitle];
			const items = [];

			if (kimi) {
				const weekly = kimi.weekly || {};
				const rolling = kimi.rolling5h || {};
				items.push(metric("weekly", weekly.stale ? YELLOW : dotForPoints(weekly.remaining, panel), T.week(fmtPct(weekly.remaining, weekly.limit) || T.na)));
				items.push(metric("5h", rolling.stale ? YELLOW : dotForPoints(rolling.remaining, panel), T.fiveH(fmtPct(rolling.remaining, rolling.limit) || T.na)));
				titleLines.push(T.tipWeek(weekly.remaining ?? T.na, weekly.limit ?? T.na, fmtTime(Date.parse(weekly.resetTime || "")) || T.na) + (weekly.stale ? T.tipSourceStale : ""));
				titleLines.push(T.tip5h(rolling.remaining ?? T.na, rolling.limit ?? T.na) + (rolling.stale ? T.tipSourceStale : ""));
			}
			if (deepseek && typeof deepseek.balanceUsd === "number") {
				items.push(metric("ds", deepseek.stale ? YELLOW : dotForBalance(deepseek.balanceUsd, panel), T.ds(fmtUsd(deepseek.balanceUsd) || T.na)));
				if (deepseek.stale) titleLines.push(T.tipSourceStale);
			}
			const costUsd = fmtUsd(cost.todayUsd);
			if (costUsd !== null) {
				items.push(metric("cost", overCap ? RED : GREEN, T.cost(costUsd)));
				if (cost.incomplete) {
					const models = Array.isArray(cost.unknownModels) && cost.unknownModels.length ? cost.unknownModels.join(", ") : T.na;
					titleLines.push(T.tipCostIncomplete(models));
				}
			}

			// Codex (ChatGPT subscription): hidden when no local credential.
			if (codex && codex.available !== false) {
				if (codex.error) {
					items.push(metric("codex", GRAY, T.codexUnknown));
					titleLines.push(T.tipCodexError(codex.error));
				} else if (codex.primary || codex.secondary) {
					// Chip shows the most constrained window.
					const wins = [codex.primary, codex.secondary].filter(function (w) { return w && typeof w.usedPercent === "number"; });
					const main = wins.sort(function (a, b) { return b.usedPercent - a.usedPercent; })[0] || null;
					const left = main ? Math.max(0, Math.round(100 - main.usedPercent)) : null;
					const isWeek = main && typeof main.windowSeconds === "number" && main.windowSeconds >= 86400;
					const text = codex.limitReached ? T.codexOut
						: left === null ? T.codexUnknown
						: isWeek ? T.codexWeek(left + "%") : T.codexHours(main.windowSeconds ? Math.round(main.windowSeconds / 3600) : "?", left + "%");
					items.push(metric("codex", codex.limitReached ? RED : dotForPercentLeft(left), text));
					if (codex.plan) titleLines.push(T.tipCodexPlan(codex.plan));
					if (codex.primary) titleLines.push(T.tipCodexWin(windowLabel(T, codex.primary.windowSeconds), Math.round(codex.primary.usedPercent ?? 0), fmtTime(codex.primary.resetAt)));
					if (codex.secondary) titleLines.push(T.tipCodexWin(windowLabel(T, codex.secondary.windowSeconds), Math.round(codex.secondary.usedPercent ?? 0), fmtTime(codex.secondary.resetAt)));
					if (codex.spark && codex.spark.primary) {
						titleLines.push(T.tipCodexSpark(Math.round(codex.spark.primary.usedPercent ?? 0), Math.round((codex.spark.secondary && codex.spark.secondary.usedPercent) ?? 0)));
					}
					if (codex.credits && codex.credits.balance !== null && codex.credits.balance !== undefined) {
						titleLines.push(T.tipCodexCredits(codex.credits.unlimited ? "∞" : String(codex.credits.balance)));
					}
				}
			}

			// Local runtimes: only shown when at least one is detected.
			if (local && (typeof local.ollama === "number" || typeof local.lmstudio === "number")) {
				items.push(metric("local", GREEN, T.local));
				if (typeof local.ollama === "number") titleLines.push(T.tipOllama(local.ollama));
				if (typeof local.lmstudio === "number") titleLines.push(T.tipLmstudio(local.lmstudio));
			}

			if (s.updatedAt) {
				titleLines.push(T.tipUpdated(new Date(s.updatedAt).toLocaleTimeString()) + (stale ? T.tipStale : ""));
			}
			if (Array.isArray(s.notes) && s.notes.length) {
				titleLines.push(s.notes.join("\n"));
			}
			if (stale) {
				items.push(e("span", { key: "stale", style: { color: YELLOW, fontWeight: 600 } }, T.stale));
			}
			if (items.length === 0) {
				return e("span", { style: { opacity: 0.5, fontSize: 11 } }, T.unavailable);
			}

			return e("span", {
				title: titleLines.join("\n"),
				style: {
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					gap: 12,
					padding: "2px 14px",
					borderRadius: 999,
					background: "rgba(127, 127, 127, 0.10)",
					fontSize: 11,
					lineHeight: 1.7,
					userSelect: "none",
					whiteSpace: "nowrap",
					cursor: "default",
				},
			}, items);
		}

		/**
		 * Client plugin body: register the pill beside the shipped stats line.
		 * The locale service is optional — the pill falls back to the browser
		 * language when it is absent.
		 * @param ctx - the client cordis context (slots).
		 */
		function apply(ctx) {
			const localeService = ctx.get("locale");
			const Bound = function () {
				return e(QuotaDock, { localeService: localeService === undefined ? null : localeService });
			};
			ctx.slots.inject("conversation.composer.dock", function* () {
				yield ctx.slots.register(
					{ name: "conversation.composer.dock", id: "quota-autopilot", order: 10, label: "Quota" },
					Bound
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
