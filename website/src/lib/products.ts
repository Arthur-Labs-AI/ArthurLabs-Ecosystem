export type ProductId = 'studio' | 'nexus' | 'sentry';
export type Product = {
  id: ProductId; windowClass: string; name: string; role: string; color: string;
  title: [string, string]; description: string; summary: string;
  width: number; height: number; alt: string;
};
export const products: Product[] = [
  { id: 'studio', windowClass: 'arthur', name: 'Arthur Studio', role: 'IDEAS', color: 'mint',
    title: ['Think freely.', 'Connect deeply.'],
    description: 'A workspace built around capturing and growing ideas. Review what matters, see how concepts connect, and prepare structured context for engineering work.',
    summary: 'Capture ideas, discover relationships, and turn evolving knowledge into a clear starting point.',
    width: 1616, height: 998, alt: 'Arthur Studio screenshot showing idea capture and connected thinking' },
  { id: 'nexus', windowClass: 'nexus', name: 'Nexus', role: 'ORCHESTRATION', color: 'purple',
    title: ['Intelligence,', 'orchestrated.'],
    description: 'Design and execute AI workflows through a focused engineering workspace, with models, tasks, and project context brought together.',
    summary: 'Coordinate AI models, specialized agents, and engineering workflows through one runtime.',
    width: 1920, height: 912, alt: 'Nexus workspace screenshot with task prompt and navigation' },
  { id: 'sentry', windowClass: 'sentry', name: 'Sentry', role: 'INDEPENDENT QA', color: 'green',
    title: ['Confidence', 'is engineered.'],
    description: 'Independent checks for AI-generated work. See how projects are reviewed, track QA activity, and build verification into the engineering process.',
    summary: 'Apply independent QA, code review, and security checks before trusting the result.',
    width: 1917, height: 1050, alt: 'Sentry dashboard screenshot with projects and QA status' },
];
