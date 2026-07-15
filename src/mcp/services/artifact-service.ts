// ══════════════════════════════════════════════════════════════════════
// artifact-service.ts — Implementation of IArtifactService
// ══════════════════════════════════════════════════════════════════════

import type { IArtifactService, ArtifactInput } from "../types.js";
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
}
