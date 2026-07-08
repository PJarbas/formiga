// ══════════════════════════════════════════════════════════════════════
// communication.ts — AgentMessenger implementation (mailbox-based)
// ══════════════════════════════════════════════════════════════════════

import type { AgentMessage, AgentMessenger } from "../agents/interfaces.js";

export class AgentMessengerImpl implements AgentMessenger {
  private mailboxes = new Map<string, AgentMessage[]>();
  /** Registry of all known agents — broadcast iterates this, not mailboxes.keys(). */
  private knownAgents = new Set<string>();

  /** Register an agent so broadcast can reach it even before any message arrives. */
  register(agentName: string): void {
    this.knownAgents.add(agentName);
    if (!this.mailboxes.has(agentName)) {
      this.mailboxes.set(agentName, []);
    }
  }

  send(message: AgentMessage): void {
    this.register(message.to);
    const box = this.mailboxes.get(message.to)!;
    box.push(message);
  }

  receive(agentName: string): AgentMessage[] {
    const box = this.mailboxes.get(agentName) ?? [];
    this.mailboxes.delete(agentName);
    return box;
  }

  broadcast(from: string, content: string): void {
    const timestamp = new Date().toISOString();
    for (const agentName of this.knownAgents) {
      if (agentName !== from) {
        this.send({
          from,
          to: agentName,
          timestamp,
          content,
          type: "status",
        });
      }
    }
  }

  /** Peek at messages without consuming them. */
  peek(agentName: string): AgentMessage[] {
    return this.mailboxes.get(agentName) ?? [];
  }

  /** Total pending messages across all mailboxes. */
  get pendingCount(): number {
    let count = 0;
    for (const box of this.mailboxes.values()) {
      count += box.length;
    }
    return count;
  }
}
