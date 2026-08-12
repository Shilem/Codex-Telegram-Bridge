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
  service_tier: string | null;
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
    const resolvedId = this.resolveId(projectId);
    const changes = this.database.connection
      .prepare("UPDATE projects SET enabled = 0, updated_at = ? WHERE id = ?")
      .run(now, resolvedId).changes;
    if (changes !== 1) throw new Error(`Project not found: ${projectId}`);
  }

  remove(projectId: string): void {
    const resolvedId = this.resolveId(projectId);
    const project = this.require(resolvedId);
    if (project.enabled) throw new ProjectBoundaryError("必须先禁用项目，才能将其移除");
    const references = this.database.connection
      .prepare(`SELECT
        (SELECT COUNT(*) FROM tasks WHERE project_id = ?) AS tasks,
        (SELECT COUNT(*) FROM threads WHERE project_id = ?) AS threads`)
      .get(resolvedId, resolvedId) as { tasks: number; threads: number };
    if (references.tasks > 0 || references.threads > 0) {
      throw new ProjectBoundaryError(`项目仍被 ${references.tasks} 个任务和 ${references.threads} 个会话引用，只能保持禁用`);
    }
    this.database.connection.transaction(() => {
      this.database.connection.prepare("DELETE FROM runtime_settings WHERE key = 'active_project_id' AND value = ?").run(resolvedId);
      const changes = this.database.connection.prepare("DELETE FROM projects WHERE id = ?").run(resolvedId).changes;
      if (changes !== 1) throw new Error(`Project not found: ${projectId}`);
    })();
  }

  require(projectId: string): ProjectRecord {
    const resolvedId = this.resolveId(projectId);
    const row = this.database.connection.prepare("SELECT * FROM projects WHERE id = ?").get(resolvedId) as
      | ProjectRow
      | undefined;
    if (row === undefined) throw new Error(`Project not found: ${projectId}`);
    return mapProject(row);
  }

  resolveId(projectId: string): string {
    const exact = this.database.connection.prepare("SELECT id FROM projects WHERE id = ?").get(projectId) as { id: string } | undefined;
    if (exact) return exact.id;
    if (!/^[0-9a-f-]{6,36}$/i.test(projectId)) throw new Error(`Project not found: ${projectId}`);
    const matches = this.database.connection
      .prepare("SELECT id FROM projects WHERE id LIKE ? ORDER BY id LIMIT 2")
      .all(`${projectId}%`) as Array<{ id: string }>;
    const match = matches[0];
    if (!match) throw new Error(`Project not found: ${projectId}`);
    if (matches.length > 1) throw new ProjectBoundaryError(`项目短 ID 不唯一，请输入更多字符：${projectId}`);
    return match.id;
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

export function shortProjectId(projectId: string): string {
  return projectId.slice(0, 8);
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
    serviceTier: row.service_tier,
    permissionProfile: row.permission_profile,
    enabled: row.enabled === 1,
  };
}
