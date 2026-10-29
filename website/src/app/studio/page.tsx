import type {Metadata} from 'next';
import {StudioExperience} from '@/components/studio-concept/StudioExperience';

export const metadata:Metadata={
  title:'Arthur Studio — A home for unfinished ideas.',
  description:'Capture ideas, explore their connections and revisit their history in Arthur Studio. Discover the Infinite Desk and verified download availability.',
};

export default function StudioPage(){return <StudioExperience/>;}
