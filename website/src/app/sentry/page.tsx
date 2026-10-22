import type {Metadata} from 'next';
import {SentryHero} from '@/components/sentry-concept/Hero';
import {ChamberExperience} from '@/components/sentry-concept/ChamberExperience';
import {HarnessesSection,SupportingSections} from '@/components/sentry-concept/SupportingSections';
import {SentryDownloads} from '@/components/sentry-concept/Downloads';
import {verifiedSentryReleases} from '@/components/sentry-concept/releases';
import {SentryResources} from '@/components/sentry-product/Resources';
import styles from '@/components/sentry-concept/chamber.module.css';
export const metadata:Metadata={title:'Sentry — Independent AI Code Review',description:'Independent code review through OpenCode, DeepSeek and GLM via Claude Code. Traceable evidence, private workspaces and verified Sentry release information.'};
export default function SentryPage(){return <div className={styles.page}><SentryHero productPage/><ChamberExperience scopeNumber="03" beforeScope={<HarnessesSection number="02"/>}/><SupportingSections includeHarnesses={false}/><SentryDownloads releases={verifiedSentryReleases()}/><SentryResources/></div>;}
