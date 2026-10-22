/** Distribution metadata only. No application authority or inferred platform support. */
export type PackageId = 'suite' | 'studio' | 'nexus' | 'sentry';
export type Artifact = {
    package: PackageId;
    version: string;
    system: string;
    architecture: string;
    url: string;
    filename: string;
    format: string;
    evidence: string;
    verifiedAt: string;
    state: 'verified' | 'withdrawn';
};
export const releaseCatalog: readonly Artifact[] = [];
export function eligibleArtifacts(id: PackageId, catalog = releaseCatalog) {
    return catalog.filter(a => a.package === id && a.state === 'verified' &&
        /^https:\/\//.test(a.url) && a.evidence.trim() && !Number.isNaN(Date.parse(a.verifiedAt)) &&
        [a.version, a.system, a.architecture, a.filename, a.format].every(v => v.trim()));
}
