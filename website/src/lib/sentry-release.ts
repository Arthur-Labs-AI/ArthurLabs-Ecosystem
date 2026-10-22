import type {Artifact} from './release-types';
export type SentryRelease=Artifact&{package:'sentry';releaseNotes:string;installation:string;checksumUrl:string;sha256:string;sourceCommit:string;bytes:number;requirements:readonly string[];cli:'included'};
/** Reviewed distribution facts shared by Suite and both Sentry routes. */
export const sentryReleaseCatalog:readonly SentryRelease[]=[{
 package:'sentry',state:'verified',version:'1.0.2',system:'Windows 11 + WSL2',architecture:'x64',format:'Unsigned ZIP · online runtime bootstrap',filename:'sentry-1.0.2-2640efcd7874-windows-x64.zip',url:'https://github.com/Mert1026/Sentry/releases/download/v1.0.2/sentry-1.0.2-2640efcd7874-windows-x64.zip',evidence:'2026-10-22 published GitHub Release metadata; streamed 122864963 bytes; computed SHA256 matches asset digest and published sidecar. Revalidated receipt artifacts/phase-4b/release-revalidation.json.',verifiedAt:'2026-10-22T10:13:56.792Z',releaseNotes:'https://github.com/Mert1026/Sentry/releases/tag/v1.0.2',installation:'https://github.com/Mert1026/Sentry/releases/tag/v1.0.2',checksumUrl:'https://github.com/Mert1026/Sentry/releases/download/v1.0.2/sentry-1.0.2-2640efcd7874-windows-x64.zip.sha256',sha256:'5265713af248297c543bf0d41093258bd0e7d8c177e0b1c544e733750347286f',sourceCommit:'2640efcd78744cb02c517a405e648722e662bd60',bytes:122864963,requirements:['Windows 11 x64 + WSL2; Ubuntu preferred.','Online setup; Linux Node ≥22, pnpm 9.12.3, systemd user services, bubblewrap and socat.','Provider tooling, configured accounts and prerequisites required. Provider usage charges are separate.'],cli:'included',
}];

/** Structural guard only; publication and bytes are audited separately at promotion time. */
export function hasSentryMetadata(a:Artifact):a is SentryRelease {
 const r=a as Partial<SentryRelease>;
 return r.package==='sentry'&&[r.releaseNotes,r.installation,r.checksumUrl].every(u=>typeof u==='string'&&/^https:\/\/[^\s]+$/.test(u))&&typeof r.sha256==='string'&&/^[a-f0-9]{64}$/.test(r.sha256)&&typeof r.sourceCommit==='string'&&/^[a-f0-9]{40}$/.test(r.sourceCommit)&&typeof r.bytes==='number'&&r.bytes>0&&Array.isArray(r.requirements)&&r.requirements.length>0&&r.requirements.every(s=>typeof s==='string'&&s.trim())&&r.cli==='included';
}
