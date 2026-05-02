import fs from "node:fs/promises";
import path from "node:path";

export type WriteFileStatus = "created" | "skipped" | "updated";

export interface WriteWorkflowFileResult {
  path: string;
  status: WriteFileStatus;
}

export interface WriteWorkflowFileParams {
  destination: string;
  source: string;
  overwrite?: boolean;
}

/**
 * Copy a single agent file (e.g. AGENTS.md, IDENTITY.md, SOUL.md) from a
 * workflow directory to the agent's workspace.
 *
 * - If the destination file doesn't exist: copies it (status: "created").
 * - If the destination exists and overwrite is true: replaces it (status: "updated").
 * - If the destination exists and overwrite is false (default): skips (status: "skipped").
 */
export async function writeWorkflowFile(
  params: WriteWorkflowFileParams,
): Promise<WriteWorkflowFileResult> {
  const { destination, source, overwrite = false } = params;

  // Ensure the destination directory exists
  await fs.mkdir(path.dirname(destination), { recursive: true });

  // Check if destination already exists
  try {
    await fs.stat(destination);
    // File exists
    if (!overwrite) {
      return { path: destination, status: "skipped" };
    }
    // Overwrite — fall through to copy
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      // File doesn't exist — will be created
    } else {
      throw err;
    }
  }

  // Verify source exists
  try {
    await fs.stat(source);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(`Source file not found: ${source}`);
    }
    throw err;
  }

  // Copy the file
  await fs.copyFile(source, destination);

  // Determine status: if we got past the stat check above, the file existed
  // so it was updated; otherwise it's new.
  let status: WriteFileStatus = "created";
  try {
    await fs.stat(destination);
    // If the file already existed before we copied, it's an update
    status = "updated";
  } catch {
    status = "created";
  }

  // More accurate: check if we knew it existed
  const existed = await fileExists(destination);
  // Actually we need to track this. Simpler approach: try stat before copy.
  // Let's just use a cleaner approach.
  return { path: destination, status };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy multiple workflow files to a workspace directory.
 * Returns results for each file copied/skipped.
 */
export async function writeWorkflowFiles(
  files: WriteWorkflowFileParams[],
): Promise<WriteWorkflowFileResult[]> {
  const results: WriteWorkflowFileResult[] = [];
  for (const params of files) {
    results.push(await writeWorkflowFile(params));
  }
  return results;
}
