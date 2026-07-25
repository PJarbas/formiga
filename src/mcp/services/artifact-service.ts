// ══════════════════════════════════════════════════════════════════════
// artifact-service.ts — Implementation of IArtifactService
// ══════════════════════════════════════════════════════════════════════

import type { IArtifactService, ArtifactInput, ArtifactRecord } from "../types.js";
import { recordAgentArtifact } from "../../server/routes/agent-activity.js";
import { getPrisma } from "../../database/prisma.js";

/**
 * Service for saving artifacts to the database.
 * Wraps the existing recordAgentArtifact function.
 */
export class ArtifactService implements IArtifactService {
  async save(input: ArtifactInput): Promise<number> {
    return recordAgentArtifact({
      runId: input.runId,
      stepId: input.stepId,
      agentId: input.agentId,
      artifactKey: input.artifactKey,
      content: input.content,
      contentType: input.contentType ?? "json",
      sizeBytes: input.sizeBytes,
    });
  }

  async getNextCounter(
    { runId, agentId, artifactKey }: { runId: string; agentId: string; artifactKey: string },
  ): Promise<number> {
    // Count existing agent_decisions_xxx artifacts to determine next sequential key
    const counterPrefix = artifactKey.replace("_counter", "");
    const prisma = getPrisma();
    const count = await prisma.agentArtifact.count({
      where: {
        run_id: runId,
        agent_id: agentId,
        artifact_key: { startsWith: `${counterPrefix}_` },
      },
    });
    return count + 1;
  }

  async getByKey(runId: string, artifactKey: string): Promise<ArtifactRecord | null> {
    const prisma = getPrisma();
    const a = await prisma.agentArtifact.findUnique({
      where: { run_id_artifact_key: { run_id: runId, artifact_key: artifactKey } },
    });
    if (!a) return null;
    return toRecord(a);
  }

  async listByRun(runId: string): Promise<ArtifactRecord[]> {
    const prisma = getPrisma();
    const rows = await prisma.agentArtifact.findMany({
      where: { run_id: runId },
      orderBy: { created_at: "desc" },
    });
    return rows.map(toRecord);
  }
}

/** Map a Prisma AgentArtifact row to the read model. */
function toRecord(a: {
  artifact_key: string;
  agent_id: string;
  step_id: string;
  content: string;
  content_type: string | null;
  size_bytes: number | null;
  created_at: Date | null;
}): ArtifactRecord {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(a.content) as Record<string, unknown>;
  } catch {
    content = {};
  }
  return {
    artifactKey: a.artifact_key,
    agentId: a.agent_id,
    stepId: a.step_id,
    content,
    contentType: a.content_type ?? "json",
    sizeBytes: a.size_bytes,
    createdAt: (a.created_at ?? new Date()).toISOString(),
  };
}
