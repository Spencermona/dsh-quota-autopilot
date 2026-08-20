// Default configuration for dsh-quota-autopilot.
// Every threshold / budget / routing rule lives here; users override any of it
// through the plugin row's `config` in cordis.patch.yml (deep-merged).
//
// No personal data, no absolute paths, no API keys — keys are read by name
// from $DSH_HOME/.credentials.yaml at runtime (see src/paths.mjs).

export const DEFAULT_CONFIG = {
  // --- credentials (key NAMES in $DSH_HOME/.credentials.yaml, never key values) ---
  credentials: {
    kimiKeyName: 'KIMI_CODING_API_KEY',
    deepseekKeyName: 'DEEPSEEK_API_KEY',
  },

  // --- polling ---
  poll: {
    intervalMin: 5,
    kimiUsageUrl: 'https://api.kimi.com/coding/v1/usages',   // plural! singular /v1/usage is 404
    deepseekBalanceUrl: 'https://api.deepseek.com/user/balance',
    timeoutMs: 15000,
  },

  // --- budget ---
  dailyBudgetUsd: 5,

  // --- calibration ---
  // tok/pt ratio is LEARNED, never guessed: null until auto-calibration completes
  // (>=24h of snapshots AND >=3 points net increase). Before that, anything that
  // would need the ratio reports status "learning".
  calibration: {
    minSpanHours: 24,
    minPointDelta: 3,
    driftRelearnPct: 30,
  },

  // --- roles: user overrides. Empty by default -> knowledge base + probing fills. ---
  // roles.main = { provider, model, reasoningEffort? } etc. Explicit user mapping
  // is the ONLY way an unknown model enters routing (anti-burn guardrail).
  roles: {},

  // --- routing rules: reference ROLES, never models ---
  rules: [
    { id: 'batch-simple', when: { type: ['batch', 'summary', 'chat'] }, role: 'worker', score: 100, why: 'simple/high-frequency/batch tasks go to the worker role to save money' },
    { id: 'long-context', when: { minEstTokens: 200000 }, role: 'long-context', score: 95, why: 'long context (>200k est tokens) goes to the long-context role' },
    { id: 'vision', when: { type: ['vision'] }, role: 'long-context', score: 95, why: 'vision tasks go to the long-context role' },
    { id: 'review', when: { type: ['review'] }, role: 'reviewer', score: 90, why: 'independent review uses the reviewer role' },
    { id: 'coding-main', when: { type: ['coding', 'research'] }, role: 'main', score: 80, why: 'primary coding/complex reasoning uses the main role' },
  ],
  fallback: { role: 'main', score: 50, why: 'default primary role' },
  modifiers: [
    { id: 'kimi-subscription-bonus', when: { kimiWeeklyRemainingPctGt: 50, kimiWeeklyResetWithinH: 48 }, role: 'long-context', addScore: 40, why: 'Kimi weekly quota >50% and resets within 48h: prefer spending subscription quota' },
    { id: 'deepseek-over-budget', when: { deepseekTodayUsdGt: 5 }, roles: ['main', 'reviewer'], addScore: -60, why: 'DeepSeek daily spend over budget: downgrade non-critical tasks', downgradeTo: 'worker' },
  ],

  // --- quota state machine ---
  stateMachine: {
    emergency: { kimiWeeklyRemainingLte: 2, kimiRolling5hRemainingLte: 2, deepseekBalanceLt: 0.5 },
    reserve: { kimiWeeklyRemainingLte: 10, kimiRolling5hRemainingLte: 10, deepseekBalanceLt: 1 },
    conserve: { kimiWeeklyRemainingPctLte: 25, kimiRolling5hRemainingLte: 25, deepseekTodayUsdGtPct: 50 },
    aggressive: { kimiWeeklyRemainingPctGt: 50, kimiRolling5hRemainingGt: 50, deepseekTodayUsdLtPct: 25 },
  },
  stateActions: {
    AGGRESSIVE: 'Quota healthy: primary tasks may use the long-context role; spend subscription quota first',
    NORMAL: 'Normal usage, no downgrade suggested',
    CONSERVE: 'Suggest downgrading: non-critical tasks to the worker role, delay batch jobs',
    RESERVE: 'Suggest critical tasks only; pause batch/review work',
    EMERGENCY: 'Suggest stopping new tasks: quota nearly exhausted; wait for window reset or top up manually',
  },
}

// Deep merge of user config over defaults. Arrays are replaced wholesale
// (rule lists are authored units); plain objects merge recursively.
export function mergeConfig(user) {
  if (!user || typeof user !== 'object') return structuredClone(DEFAULT_CONFIG)
  const merge = (base, over) => {
    if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || base === null ||
        typeof over !== 'object' || over === null) {
      return over === undefined ? base : over
    }
    const out = { ...base }
    for (const k of Object.keys(over)) out[k] = merge(base[k], over[k])
    return out
  }
  return merge(structuredClone(DEFAULT_CONFIG), user)
}
