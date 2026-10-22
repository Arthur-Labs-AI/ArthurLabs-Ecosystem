import { eligibleArtifacts, releaseCatalog, type Artifact } from '../suite-launch/releases';
export const nexusTargets = ['Windows','Linux','macOS'] as const;
export type NexusTarget = typeof nexusTargets[number];
/** Installation and notes must be reviewed alongside the artifact, never inferred. */
export type NexusRelease = Artifact & {
  package: 'nexus';
  system: NexusTarget;
  releaseNotes: string;
  installation: readonly string[];
  cli?: { availability: 'included' | 'separate'; instructions: readonly string[] };
};
export function verifiedNexusReleases(catalog: readonly Artifact[] = releaseCatalog): NexusRelease[] {
  return eligibleArtifacts('nexus',catalog).filter((artifact): artifact is NexusRelease => {
    const candidate = artifact as Partial<NexusRelease>;
    const cli = candidate.cli;
    return nexusTargets.includes(candidate.system as NexusTarget) &&
      typeof candidate.releaseNotes==='string' && /^https:\/\/[^\s]+$/.test(candidate.releaseNotes) &&
      Array.isArray(candidate.installation) && candidate.installation.length>0 && candidate.installation.every(s=>typeof s==='string'&&s.trim()) &&
      (!cli || (['included','separate'].includes(cli.availability) && Array.isArray(cli.instructions) && cli.instructions.length>0 && cli.instructions.every(s=>typeof s==='string'&&s.trim()))) &&
      /^https:\/\/[^\s]+$/.test(artifact.url);
  });
}
