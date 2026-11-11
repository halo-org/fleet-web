import { request, prepareWrite, write } from './api.js';
import { compare } from './state.js';

// Collection revisions and read revisions are not metadata versions. Use the
// shared metadata version to choose between the two independently arriving feeds.
export function newestMetadata(summary, metadata) {
  if (!summary) return metadata;
  if (!metadata) return summary;
  return compare(summary.metadata_version, metadata.metadata_version) > 0 ? summary : metadata;
}

export function agentTitle(agent, role = agent.role) {
  return agent.title || `${role} · ${agent.id.slice(-6)}`;
}

export function initialTitle(text) {
  return [...text.replaceAll(/\s+/g, ' ').trim()].slice(0, 100).join('');
}

export class TitleEdit {
  operation = null;
  conflict = false;
  saving = false;

  constructor(agent) {
    this.id = agent.id;
    this.version = agent.metadata_version;
    this.current = agent.title;
    this.value = agent.title || '';
  }

  async save() {
    if (this.conflict) throw new Error('Load the current title before saving again.');
    const title = this.value.trim() || null;
    if (this.operation && this.operation.body.title !== title)
      throw new Error('Retry the unconfirmed edit before changing its title.');
    this.operation ||= prepareWrite(
      `/agents/${this.id}/title`,
      { title },
      { method: 'PUT', version: this.version },
    );
    try {
      await write(this.operation);
      this.operation = null;
    } catch (error) {
      if (error.status && error.status < 500) {
        this.operation = null;
        this.conflict = error.status === 412;
      }
      // On an uncertain result, keep the exact key, payload and precondition.
      throw error;
    }
  }

  async refresh() {
    const response = await request(`/agents/${this.id}`, {
      signal: AbortSignal.timeout(15_000),
    });
    this.version = response.data.metadata_version;
    this.current = response.data.title;
    this.conflict = false;
    // Keep the draft; refreshing a conflict is not permission to overwrite it.
    return response;
  }
}
