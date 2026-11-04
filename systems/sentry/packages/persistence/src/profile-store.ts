import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ProjectProfileSchema, type ProjectProfile } from '@qa/schemas';
import type { AgentStackId, ProjectId } from '@qa/shared';
import { projectDataPaths, resolveInside } from './paths.js';

/**
 * One JSON file per project and agent stack, next to (never inside) the working
 * copy. Removing a project removes its whole tree, profiles included.
 */
export class ProjectProfileStore {
  constructor(private readonly dataRoot: string) {}

  private fileFor(projectId: ProjectId, agentStackId: AgentStackId): string {
    const folder = resolve(projectDataPaths(this.dataRoot, projectId).root, 'profiles');
    return resolveInside(folder, agentStackId + '.json');
  }

  /** The stored profile, or undefined when missing or unreadable (never throws on bad content). */
  async read(
    projectId: ProjectId,
    agentStackId: AgentStackId,
  ): Promise<ProjectProfile | undefined> {
    try {
      const parsed = ProjectProfileSchema.safeParse(
        JSON.parse(await readFile(this.fileFor(projectId, agentStackId), 'utf8')),
      );
      return parsed.success &&
        parsed.data.projectId === projectId &&
        parsed.data.agentStackId === agentStackId
        ? parsed.data
        : undefined;
    } catch {
      return undefined;
    }
  }

  async write(profile: ProjectProfile): Promise<void> {
    const valid = ProjectProfileSchema.parse(profile);
    const target = this.fileFor(valid.projectId, valid.agentStackId);
    await mkdir(dirname(target), { recursive: true });
    const temporary = target + '.tmp';
    await writeFile(temporary, JSON.stringify(valid), 'utf8');
    await rename(temporary, target);
  }

  async remove(projectId: ProjectId, agentStackId: AgentStackId): Promise<void> {
    await rm(this.fileFor(projectId, agentStackId), { force: true });
  }
}
