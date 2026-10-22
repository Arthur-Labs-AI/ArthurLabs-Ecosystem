import type { Metadata } from 'next';
import { NexusHero } from '@/components/nexus-concept/Hero';
import { NativeCore } from '@/components/nexus-concept/features/NativeCore';
import { Nova } from '@/components/nexus-concept/features/Nova';
import { Compaction } from '@/components/nexus-concept/features/Compaction';
import { Registry } from '@/components/nexus-concept/features/Registry';
import { NexusDownloads } from '@/components/nexus-download/NexusDownloads';
import { verifiedNexusReleases } from '@/components/nexus-download/releases';
import { ProductNav } from '@/components/nexus-product/ProductNav';
import { EngineeringMode, Interfaces, SentryIntegration, Resources } from '@/components/nexus-product/ProductSections';
import hero from '@/components/nexus-concept/engine.module.css';
import features from '@/components/nexus-concept/features/features.module.css';
import styles from '@/components/nexus-product/product.module.css';
export const metadata: Metadata = {title:'Nexus — One task. The right intelligence.',description:'Explore Nexus native execution, planned Nova orchestration, context continuity, model configuration and verified download availability.'};
export default function NexusPage(){return <div className={`${hero.page} ${features.page} ${styles.page}`}><NexusHero productPage/><ProductNav/><NativeCore/><Nova productPage/><Compaction productPage/><Registry productPage/><EngineeringMode/><Interfaces/><SentryIntegration/><NexusDownloads releases={verifiedNexusReleases()}/><Resources/></div>;}
