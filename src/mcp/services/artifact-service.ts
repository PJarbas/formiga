// ══════════════════════════════════════════════════════════════════════
// artifact-service.ts — Implementation of IArtifactService
// ══════════════════════════════════════════════════════════════════════

import type { IArtifactService, ArtifactInput } from "../types.js";
import { recordAgentArtifact } from "../../server/routes/agent-activity.js";

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
}
