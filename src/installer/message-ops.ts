// ══════════════════════════════════════════════════════════════════════
// message-ops.ts — Inter-agent message board operations
// ══════════════════════════════════════════════════════════════════════
//
// Lightweight message-passing system using the existing AgentArtifact
// table. Messages are stored with artifact_key pattern:
//   message/<from-agent>/<to-agent>/<uuid>
// and content_type: "message".
//
// This avoids a schema migration and reuses the existing upsert/index
// infrastructure. Agents send messages via CLI (`formiga message send`)
// and receive them via headers injected into the polling prompt.
// ══════════════════════════════════════════════════════════════════════

import crypto from "node:crypto";
import { getPrisma } from "../db.js";
import { logger } from "../lib/logger.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface AgentMessage {
  messageKey: string;
  fromAgent: string;
  toAgent: string;
  timestamp: Date;
  content: unknown;
}

export interface ListMessagesFilter {
  fromAgent?: string;
}

// ── Message key format ────────────────────────────────────────────────

const MESSAGE_KEY_PREFIX = "message/";

function buildMessageKey(fromAgent: string, toAgent: string): string {
  const uid = crypto.randomUUID().slice(0, 8);
  return `${MESSAGE_KEY_PREFIX}${fromAgent}/${toAgent}/${uid}`;
}

function parseMessageKey(key: string): { fromAgent: string; toAgent: string; uid: string } | null {
  const parts = key.split("/");
  if (parts[0] !== "message" || parts.length !== 4) return null;
  return { fromAgent: parts[1], toAgent: parts[2], uid: parts[3] };
}

// ── Send ──────────────────────────────────────────────────────────────

/**
 * Send a message from one agent to another.
 * Stored as an AgentArtifact with content_type "message".
 */
export async function sendMessage(
  runId: string,
  stepId: string,
  fromAgent: string,
  toAgent: string,
  payload: unknown,
): Promise<string> {
  const prisma = getPrisma();
  const messageKey = buildMessageKey(fromAgent, toAgent);

  const content = typeof payload === "string" ? payload : JSON.stringify(payload);

  await prisma.agentArtifact.create({
    data: {
      run_id: runId,
      step_id: stepId,
      agent_id: fromAgent,
      artifact_key: messageKey,
      content,
      content_type: "message",
    },
  });

  logger.debug("Message sent", { fromAgent, toAgent, messageKey, runId });
  return messageKey;
}

// ── List ──────────────────────────────────────────────────────────────

/**
 * List messages addressed to an agent in a run.
 * Optionally filter by sender.
 */
export async function listMessages(
  toAgent: string,
  runId: string,
  filters?: ListMessagesFilter,
): Promise<AgentMessage[]> {
  const prisma = getPrisma();

  // Query all message artifacts for this run
  const keyPrefix = filters?.fromAgent
    ? `${MESSAGE_KEY_PREFIX}${filters.fromAgent}/${toAgent}/`
    : `${MESSAGE_KEY_PREFIX}`;

  const artifacts = await prisma.agentArtifact.findMany({
    where: {
      run_id: runId,
      artifact_key: { startsWith: keyPrefix },
      content_type: "message",
    },
    orderBy: { created_at: "asc" },
  });

  const messages: AgentMessage[] = [];

  for (const artifact of artifacts) {
    const parsed = parseMessageKey(artifact.artifact_key);
    if (!parsed) continue;
    // If no fromAgent filter, verify toAgent matches
    if (!filters?.fromAgent && parsed.toAgent !== toAgent) continue;

    let content: unknown;
    try {
      content = JSON.parse(artifact.content);
    } catch {
      content = artifact.content;
    }

    messages.push({
      messageKey: artifact.artifact_key,
      fromAgent: parsed.fromAgent,
      toAgent: parsed.toAgent,
      timestamp: artifact.created_at ?? new Date(),
      content,
    });
  }

  return messages;
}

// ── Read ──────────────────────────────────────────────────────────────

/**
 * Read a single message by its key.
 */
export async function readMessage(
  messageKey: string,
  runId: string,
): Promise<AgentMessage> {
  const prisma = getPrisma();

  const artifact = await prisma.agentArtifact.findUnique({
    where: {
      run_id_artifact_key: { run_id: runId, artifact_key: messageKey },
    },
  });

  if (!artifact || artifact.content_type !== "message") {
    throw new Error(`Message not found: ${messageKey}`);
  }

  const parsed = parseMessageKey(artifact.artifact_key);
  if (!parsed) throw new Error(`Invalid message key: ${messageKey}`);

  let content: unknown;
  try {
    content = JSON.parse(artifact.content);
  } catch {
    content = artifact.content;
  }

  return {
    messageKey: artifact.artifact_key,
    fromAgent: parsed.fromAgent,
    toAgent: parsed.toAgent,
    timestamp: artifact.created_at ?? new Date(),
    content,
  };
}

// ── Prompt header ─────────────────────────────────────────────────────

/**
 * Build a formatted header of unread messages for injection into
 * the polling prompt. Returns empty string if no messages.
 */
export async function getUnreadMessagesHeader(
  agentId: string,
  runId: string,
): Promise<string> {
  const messages = await listMessages(agentId, runId);
  if (messages.length === 0) return "";

  const cli = process.env.FORMIGA_CLI_PATH ?? "formiga";

  const lines = [
    "",
    "─── UNREAD MESSAGES ───",
    `You have ${messages.length} message(s) from other agents:`,
  ];

  for (const msg of messages) {
    const preview = typeof msg.content === "object"
      ? JSON.stringify(msg.content).slice(0, 120)
      : String(msg.content).slice(0, 120);
    lines.push(`  From: ${msg.fromAgent} — ${preview}`);
    lines.push(`  Key: ${msg.messageKey}`);
  }

  lines.push(
    `To read full content: ${cli} message read <key> --run-id ${runId}`,
    "─── END MESSAGES ───",
  );

  return lines.join("\n");
}