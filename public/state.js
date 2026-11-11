export const compare = (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
export const minimum = (values) => values.reduce((a, b) => (compare(a, b) <= 0 ? a : b));

export class VersionedMap {
  records = new Map();
  floor = null;

  set(id, value, revision) {
    const prior = this.records.get(id);
    if (
      (this.floor !== null && compare(revision, this.floor) <= 0) ||
      (prior && compare(revision, prior.revision) < 0)
    )
      return false;
    this.records.set(id, { value, revision });
    return true;
  }

  snapshot(values, revision, key = 'id') {
    for (const value of values) this.set(value[key], value, revision);
    this.floor = revision;
  }

  values() {
    return [...this.records.values()].map((row) => row.value).filter(Boolean);
  }
  get(id) {
    return this.records.get(id)?.value;
  }
}

export class AgentList {
  agents = new VersionedMap();

  page(page) {
    for (const agent of page.agents) this.agents.set(agent.id, agent, agent.version);
  }

  update(data, revision) {
    this.page({ agents: data.agents || [] });
    for (const id of data.removed || []) this.agents.set(id, null, revision);
  }

  section(inbox) {
    return this.agents
      .values()
      .filter((agent) => agent.inbox === inbox)
      .sort((a, b) => {
        const orderA = a.position.split(':')[1];
        const orderB = b.position.split(':')[1];
        const direction = inbox === 'snoozed' ? 1 : -1;
        return direction * (compare(orderA, orderB) || compare(a.id, b.id));
      });
  }
}

export class Conversation {
  events = new VersionedMap();
  messages = new VersionedMap();
  tools = new VersionedMap();
  metadata = null;
  activity = { turn: 'idle', interrupt_pending: false };
  metadataRevision = '0';
  activityRevision = '0';
  ranges = [];
  preview = null;
  previewBlock = null;

  eventPage(events, revision, until = null) {
    for (const event of events)
      this.events.set(event.cursor, event.status === 'deleted' ? null : event, revision);
    const oldest = events.length
      ? events.reduce((a, b) => (compare(a.cursor, b.cursor) <= 0 ? a : b)).cursor
      : '0';
    this.ranges.push({ from: oldest, until, revision });
    this.discardCommittedPreview();
  }

  update(data, revision) {
    if (data.agent && compare(revision, this.metadataRevision) >= 0) {
      this.metadata = data.agent;
      this.metadataRevision = revision;
    }
    if (data.activity && compare(revision, this.activityRevision) >= 0) {
      this.activity = data.activity;
      this.activityRevision = revision;
    }
    for (const message of data.messages || []) {
      this.messages.set(message.id, message.status === 'pending' ? message : null, revision);
    }
    for (const tool of data.tool_calls || []) {
      this.tools.set(tool.id, tool.status === 'pending' ? tool : null, revision);
    }
    for (const event of data.events || []) {
      if (
        this.ranges.some(
          (range) =>
            compare(event.cursor, range.from) >= 0 &&
            (range.until === null || compare(event.cursor, range.until) < 0) &&
            compare(revision, range.revision) < 0,
        )
      )
        continue;
      this.events.set(event.cursor, event.status === 'deleted' ? null : event, revision);
    }
    this.discardCommittedPreview();
  }

  previewEvent(event) {
    if (event.type === 'preview') {
      const data = JSON.parse(event.data);
      this.preview = ['streaming', 'compacting'].includes(data.status) ? data : null;
      this.previewBlock = null;
    } else if (event.type === 'preview_block' && this.preview?.status === 'streaming') {
      const data = JSON.parse(event.data);
      this.previewBlock = data.index;
      if (data.type) {
        const block = { ...data, text: '', input: '', content: '' };
        this.preview.output = this.preview.output.filter((item) => item.index !== data.index);
        this.preview.output.push(block);
      }
    } else if (event.type === 'preview_text' && this.preview?.status === 'streaming') {
      const block = this.preview.output.find((block) => block.index === this.previewBlock);
      if (block) {
        const field =
          block.type === 'tool_call'
            ? 'input'
            : block.type === 'provider_tool_call'
              ? 'content'
              : 'text';
        block[field] += event.data;
      }
    }
    this.discardCommittedPreview();
  }

  discardCommittedPreview() {
    if (
      this.preview &&
      this.events
        .values()
        .some(
          (event) =>
            compare(event.cursor, this.preview.input_cursor) > 0 &&
            (this.preview.status === 'compacting' ||
              ['model_response', 'compaction', 'turn_end'].includes(event.payload.type)),
        )
    ) {
      this.preview = null;
      this.previewBlock = null;
    }
  }

  orderedEvents() {
    return this.events.values().sort((a, b) => compare(a.cursor, b.cursor));
  }
  pendingMessages() {
    const consumed = new Set(
      this.events
        .values()
        .filter((event) => event.payload.type === 'input')
        .map((event) => event.payload.message_id),
    );
    return this.messages
      .values()
      .filter((message) => !consumed.has(message.id))
      .sort((a, b) => compare(a.position || '0', b.position || '0'));
  }
}
