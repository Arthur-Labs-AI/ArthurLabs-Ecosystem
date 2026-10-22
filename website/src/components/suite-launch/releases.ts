import type {Artifact,PackageId} from '@/lib/release-types';
import {sentryReleaseCatalog,hasSentryMetadata} from '@/lib/sentry-release';
export type {Artifact,PackageId} from '@/lib/release-types';
/** Reviewed individual releases do not imply a unified Suite package. */
export const releaseCatalog:readonly Artifact[]=[...sentryReleaseCatalog];
export function eligibleArtifacts(id:PackageId,catalog:readonly Artifact[]=releaseCatalog){
 return catalog.filter(a=>a.package===id&&a.state==='verified'&&
 /^https:\/\/[^\s]+$/.test(a.url)&&a.evidence.trim()&&!Number.isNaN(Date.parse(a.verifiedAt))&&
 [a.version,a.system,a.architecture,a.filename,a.format].every(v=>v.trim())&&
 (a.package!=='sentry'||hasSentryMetadata(a)));
}
