import type {Metadata} from 'next';
import {StudioExperience} from '@/components/studio-concept/StudioExperience';
export const metadata:Metadata={title:'Arthur Studio — The Infinite Desk',description:'A home for unfinished ideas. Explore an illustrative creative desk grounded in the real Arthur Studio workspace.',robots:{index:false,follow:false}};
export default function StudioConceptPage(){return <StudioExperience/>;}
