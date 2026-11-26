import { write } from './api.js';

/**
 * Deleting a root agent, which takes its subagents with it. Fleet treats deleting an agent that
 * is already gone as success, so a retry after an uncertain response repeats the same request.
 */
export class AgentDeletion {
  deleting = false;
  uncertain = false;

  constructor(id) {
    this.id = id;
  }

  async send() {
    if (this.deleting) return;
    this.deleting = true;
    try {
      await write({ path: `/agents/${this.id}`, method: 'DELETE' });
      this.uncertain = false;
    } catch (error) {
      this.uncertain = !error.status || error.status >= 500;
      throw error;
    } finally {
      this.deleting = false;
    }
  }

  label() {
    return this.deleting ? 'Deleting…' : this.uncertain ? 'Retry delete' : 'Delete agent';
  }
}

export function deletionError(error, deletion) {
  if (error.status === 403)
    return 'Subagents can’t be deleted on their own. Delete the agent that created it.';
  if (deletion.uncertain) return 'Could not confirm the deletion. Retry to confirm it.';
  return error.message;
}

export function deletionText(working) {
  const text = 'The agent, its subagents and their history are permanently deleted.';
  return working ? `${text} Its running work will be stopped.` : text;
}
