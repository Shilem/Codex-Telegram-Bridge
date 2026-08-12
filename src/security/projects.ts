import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { BridgeDatabase } from "../storage/database.js";
import type { PermissionProfile, ProjectRecord } from "../storage/types.js";

interface ProjectRow {
  id: string;
  name: string;
  normalized_root: string;
  default_model: string | null;
  reasoning_effort: string | null;
  permission_profile: PermissionProfile;
  enabled: number;
}

export class ProjectBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectBoundaryError";
  }
}

export class ProjectRegistry {
  constructor(private readonly database: BridgeDatabase) {}

  register(root: string, name: string, now = Date.now()): ProjectRecord {
    const normalizedRoot = realpathSync.native(root);
    if (!statSync(normalizedRoot).isDirectory()) throw new ProjectBoundaryError("Project root is not a directory");
    const id = randomUUID();
    this.database.connection
      .prepare(
        `INSERT INTO projects(id, name, normalized_root, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, name, normalizedRoot, now, now);
    return this.require(id);
  }

  disable(projectId: string, now = Date.now()): void {
    const changes = this.database.connection
      .prepare("UPDATE projects SET enabled = 0, updated_at = ? WHERE id = ?")
      .run(now, projectId).changes;
    if (changes !== 1) throw new Error(`Project not found: ${projectId}`);
  }

  require(projectId: string): ProjectRecord {
    const row = this.database.connection.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as
      | ProjectRow
      | undefined;
    if (row === undefined) throw new Error(`Project not found: ${projectId}`);
    return mapProject(row);
  }

  assertExistingPath(projectId: string, candidate: string): string {
    const project = this.requireEnabled(projectId);
    const normalized = realpathSync.native(candidate);
    assertContained(project.normalizedRoot, normalized);
    return normalized;
  }

  assertOutputPath(projectId: string, candidate: string): string {
    const project = this.requireEnabled(projectId);
    const absolute = path.resolve(candidate);
    if (existsSync(absolute)) {
      const existing = realpathSync.native(absolute);
      assertContained(project.normalizedRoot, existing);
      return existing;
    }
    const parent = realpathSync.native(path.dirname(absolute));
    assertContained(project.normalizedRoot, parent);
    const normalized = path.join(parent, path.basename(absolute));
    assertContained(project.normalizedRoot, normalized);
    return normalized;
  }

  private requireEnabled(projectId: string): ProjectRecord {
    const project = this.require(projectId);
    if (!project.enabled) throw new ProjectBoundaryError("Project is disabled");
    return project;
  }
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return;
  }
  throw new ProjectBoundaryError("Path escapes the registered project root");
}

function mapProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    normalizedRoot: row.normalized_root,
    defaultModel: row.default_model,
    reasoningEffort: row.reasoning_effort,
    permissionProfile: row.permission_profile,
    enabled: row.enabled === 1,
  };
}
