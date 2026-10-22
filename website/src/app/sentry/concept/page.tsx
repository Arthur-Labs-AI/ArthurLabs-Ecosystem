import type {Metadata} from 'next';
import {SentryHero} from '@/components/sentry-concept/Hero';
import {ChamberExperience} from '@/components/sentry-concept/ChamberExperience';
import {SupportingSections} from '@/components/sentry-concept/SupportingSections';
import {SentryDownloads} from '@/components/sentry-concept/Downloads';
import {verifiedSentryReleases} from '@/components/sentry-concept/releases';
import styles from '@/components/sentry-concept/chamber.module.css';
export const metadata:Metadata={title:'Sentry — The Verification Chamber',description:'Explore independent AI code review through OpenCode, DeepSeek and GLM via Claude Code. A cinematic architecture concept with traceable example evidence and verified Sentry release information.'};
export default function SentryConceptPage(){return <div className={styles.page}><SentryHero/><ChamberExperience/><SupportingSections/><SentryDownloads releases={verifiedSentryReleases()}/></div>;}
