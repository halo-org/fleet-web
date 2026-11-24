import { prepareWrite, write } from './api.js';

// Fleet sends a reason's kind and names, never text. Unknown kinds get no detail.
const reasons = {
  role_not_found: [['role'], ({ role }) => `Role “${role}” doesn’t exist.`],
  model_not_found: [
    ['role', 'model'],
    ({ role, model }) => `Role “${role}” uses model “${model}”, which doesn’t exist.`,
  ],
  tool_not_found: [
    ['role', 'tool'],
    ({ role, tool }) => `Role “${role}” uses tool “${tool}”, which doesn’t exist.`,
  ],
  invalid_model_parameters: [
    ['role'],
    ({ role }) => `Role “${role}” can’t apply the agent’s parameters to its model.`,
  ],
  invalid_tool_parameters: [
    ['role'],
    ({ role }) => `Role “${role}” can’t apply the agent’s parameters to its tools.`,
  ],
  invalid_extension_parameters: [
    ['role'],
    ({ role }) => `Role “${role}” can’t apply the agent’s parameters to its extensions.`,
  ],
  model_error: [
    ['model'],
    ({ model }) => `Model “${model}” can’t be used until its connection or settings are fixed.`,
  ],
  tool_error: [
    ['tool'],
    ({ tool }) => `Tool “${tool}” can’t be used until its connection or settings are fixed.`,
  ],
  unknown_tool_error: [
    ['alias'],
    ({ alias }) =>
      `A call to unknown tool “${alias}” can’t be answered until its tool provider is fixed.`,
  ],
};

/** A short sentence for a stall reason, or '' when this client doesn't know the kind. */
export function stallReason(reason) {
  if (!Object.hasOwn(reasons, reason?.kind)) return '';
  const [fields, sentence] = reasons[reason.kind];
  return fields.every((name) => typeof reason[name] === 'string') ? sentence(reason) : '';
}

const subagents = (count) => (count === 1 ? '1 subagent' : `${count} subagents`);

/** Whether an agent's activity or summary says it or anything below it is stalled. */
export function isStalled(agent) {
  return !!agent?.stalled || agent?.stalled_descendants > 0;
}

/**
 * The conversation's notice for an agent's activity. The agent's own reason leads; otherwise
 * the reason of a stalled descendant, once one has been found.
 */
export function stallNotice(activity, descendant = null) {
  if (!isStalled(activity)) return null;
  const below = activity.stalled_descendants > 0 ? activity.stalled_descendants : 0;
  const title = activity.stalled
    ? below
      ? `This agent and ${subagents(below)} can’t continue.`
      : 'This agent can’t continue.'
    : below === 1
      ? 'A subagent can’t continue.'
      : `${subagents(below)} can’t continue.`;
  return { title, reason: stallReason(activity.stalled || descendant?.stalled) };
}

/** A subagent link's status in Trace, or null when nothing in its tree is stalled. */
export function stallStatus(agent) {
  if (agent.stalled) return { status: 'Stalled', reason: stallReason(agent.stalled) };
  if (!(agent.stalled_descendants > 0)) return null;
  const count = agent.stalled_descendants;
  return { status: count === 1 ? 'Subagent stalled' : `${count} subagents stalled`, reason: '' };
}

/**
 * Finds a stalled agent below `id`, nearest first. `children(id)` resolves to an agent's child
 * summaries. Only branches that report stalled agents are visited.
 */
export async function findStalled(id, children) {
  const queue = [id];
  const seen = new Set(queue);
  while (queue.length) {
    const agents = await children(queue.shift());
    const stalled = agents.find((agent) => agent.stalled);
    if (stalled) return stalled;
    for (const agent of agents) {
      if (agent.stalled_descendants > 0 && !seen.has(agent.id)) {
        seen.add(agent.id);
        queue.push(agent.id);
      }
    }
  }
  return null;
}

/**
 * Resuming an agent's stalled subtree. An uncertain request keeps its idempotency key until the
 * agent's revision changes: by then it either took effect or a new stall needs a new request.
 */
export class Resume {
  operation = null;
  revision = null;
  sending = false;
  // After Fleet accepts, wait for activity to change before offering Retry again.
  awaiting = null;

  constructor(id) {
    this.id = id;
  }

  waiting(revision) {
    if (this.awaiting !== null && this.awaiting !== revision) this.awaiting = null;
    return this.sending || this.awaiting !== null;
  }

  async send(revision) {
    if (this.waiting(revision)) return;
    if (!this.operation || this.revision !== revision) {
      this.operation = prepareWrite(`/agents/${this.id}/resumes`, {});
      this.revision = revision;
    }
    this.sending = true;
    try {
      await write(this.operation);
      this.operation = null;
      this.awaiting = revision;
    } catch (error) {
      if (error.status && error.status < 500) this.operation = null;
      throw error;
    } finally {
      this.sending = false;
    }
  }
}
