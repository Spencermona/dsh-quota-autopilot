// dsh-quota-autopilot advisor row — for the Auto agent preset only.
//
// Hard dependency: this row requires the host-side `autopilot` service, i.e.
// the dsh-quota-autopilot plugin must be installed into the profile and mounted via
// cordis.patch.yml (see README). Without it the row waits for the service and
// the preset will not finish mounting.
//
// It registers exactly one model tool, route_consult, and publishes nothing —
// so no isolate realm is needed in the preset composition.

export const name = 'autopilot-advisor'
// Hard deps: the host plugin's `autopilot` service, and the tools registry
// (cordis requires every ctx.<service> property access to be declared here).
export const inject = ['autopilot', 'tools']

const PROMPT_TEXT =
  'Before spawning a subagent or starting a large task, call the route_consult ' +
  'tool for a quota-aware routing recommendation, and include the advice in ' +
  'your plan. The recommendation is advisory only — never treat it as an ' +
  'actual routing change.'

export function apply(ctx) {
  // Prompt section for the mounting agent (dsh-tool-goal pattern). Optional:
  // without the systemPrompt service the tool description alone carries the
  // instruction.
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    try {
      ctx.effect(() => systemPrompt.section({
        name: 'autopilot',
        order: 115,
        text: PROMPT_TEXT,
      }), 'autopilot.section()')
    } catch (e) {
      console.warn(`WARN autopilot prompt section skipped: ${e.message}`)
    }
  }

  ctx.tools.register({
    name: 'route_consult',
    description:
      'Before spawning a subagent or starting a large task, consult for a ' +
      'quota-aware role-based route recommendation. Advisory only — it never ' +
      'changes actual routing.',
    // dsh-tools value-schema DSL: a map of parameter name -> schema
    // ({type, required, description, enum}), NOT a JSON-Schema object wrapper.
    parameters: {
      task: { type: 'string', required: true, description: 'One-sentence description of the task to route' },
      type: {
        type: 'string',
        enum: ['coding', 'research', 'vision', 'summary', 'batch', 'chat', 'review'],
        description: 'Task kind (default: coding)',
      },
      estTokens: { type: 'number', description: 'Rough estimate of total context tokens (optional)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      // The model sees the recommendation as JSON text.
      render: (_args, value) => [{
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      }],
    },
    execute: async (args, exec) => {
      // Best-effort session correlation for the shadow log; the execution
      // context shape varies, so every probe is defensive and optional.
      const sessionId =
        (typeof exec?.sessionId === 'string' && exec.sessionId) ||
        (typeof exec?.session?.id === 'string' && exec.session.id) ||
        undefined
      return ctx.autopilot.advise({
        task: args?.task,
        type: args?.type,
        estTokens: args?.estTokens,
        sessionId,
      })
    },
  })
}
