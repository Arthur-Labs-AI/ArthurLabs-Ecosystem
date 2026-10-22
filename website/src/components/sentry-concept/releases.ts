import {eligibleArtifacts,releaseCatalog,type Artifact} from '../suite-launch/releases';
import {hasSentryMetadata,type SentryRelease} from '@/lib/sentry-release';
export {sentryReleaseCatalog,type SentryRelease} from '@/lib/sentry-release';
/** Compatibility seam retained for the reference concept and its injected-catalog tests. */
export function verifiedSentryReleases(catalog:readonly Artifact[]=releaseCatalog):SentryRelease[]{return eligibleArtifacts('sentry',catalog).filter(hasSentryMetadata);}
