import{NexusHero}from'@/components/nexus-concept/Hero';
import{Overview,Closing}from'@/components/nexus-concept/features/Overview';
import{NativeCore}from'@/components/nexus-concept/features/NativeCore';
import{Nova}from'@/components/nexus-concept/features/Nova';
import{Compaction}from'@/components/nexus-concept/features/Compaction';
import{Registry}from'@/components/nexus-concept/features/Registry';
import { NexusDownloads, NexusDownloadNav } from '@/components/nexus-download/NexusDownloads';
import { verifiedNexusReleases } from '@/components/nexus-download/releases';
import heroStyles from'@/components/nexus-concept/engine.module.css';
import styles from'@/components/nexus-concept/features/features.module.css';
export const metadata={title:'Nexus — Understand the Engine',description:'Four independent interactive explanations of Native Core, planned Nexus Nova, restricted Content Compaction v2 and Model Registry.'};
export default function NexusConceptPage(){return <div className={`${heroStyles.page} ${styles.page}`}><NexusHero/><NexusDownloadNav/><Overview/><NativeCore/><Nova/><Compaction/><Registry/><Closing/><NexusDownloads releases={verifiedNexusReleases()}/></div>;}
