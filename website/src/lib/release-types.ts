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
