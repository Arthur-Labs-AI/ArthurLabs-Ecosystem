export type ObjectId = 'thought' | 'study' | 'observations' | 'question' | 'revisions' | 'studio';
export type DeskObject = {
  id: ObjectId; label: string; category: string; title: string; description: string;
  capability: string; status: 'Implemented' | 'Restricted' | 'Illustrative';
};
export const initialThought = 'What if technology could understand natural human gestures?';
export const objects: readonly DeskObject[] = [
  { id: 'thought', label: 'A thought, still unfinished', category: 'THE FIRST WORDS', title: 'Start before you know.',
    description: 'A passing thought does not need to be a finished idea. Give it a place to land, in your own words.',
    capability: 'Studio saves a typed capture locally before asking a configured provider to organize it. The original words remain available as provenance. This note is fictional sample content.', status: 'Implemented' },
  { id: 'study', label: 'A study of the human hand', category: 'A VISUAL REFERENCE', title: 'Leave room for a different angle.',
    description: 'A pinch, an open palm, a moment of hesitation. Sometimes looking at an idea is more useful than explaining it.',
    capability: 'This hand study is a website illustration. Studio does not currently provide this sketch editor or recognize gestures. Its subject is the sample idea, not a product capability.', status: 'Illustrative' },
  { id: 'observations', label: 'Three related observations', category: 'THINGS NOTICED', title: 'An idea rarely lives alone.',
    description: 'Small observations give a thought more substance. Keep their meaning distinct while noticing what they share.',
    capability: 'Studio stores structured knowledge objects with source provenance and supports typed relationships. Relations can be authored by a person; inference needs provider setup. These observations are an illustrative collection, not generated research.', status: 'Implemented' },
  { id: 'question', label: 'A question worth keeping', category: 'AN OPEN QUESTION', title: 'Follow the question.',
    description: 'Could an interface understand intention, rather than just recognize movement? Some questions deserve to stay open.',
    capability: 'Ask Arthur has a project-scoped question interface and native evidence-based recall. It requires your own knowledge and configured providers. It does not browse the web or execute Nexus tasks. No model is called on this page.', status: 'Implemented' },
  { id: 'revisions', label: 'Two versions of an idea', category: 'A CHANGE OF MIND', title: 'Let the idea change. Keep its story.',
    description: 'The first wording matters. So does the moment you see it differently. A new version need not erase the one before it.',
    capability: 'Studio supports editing, branching, merging and restoring revisions without deleting history. AI Thought Evolution is off by default and review-first: suggestions need explicit approval. Real-provider quality acceptance is outstanding.', status: 'Restricted' },
  { id: 'studio', label: 'Inside the real Arthur Studio', category: 'THE ACTUAL APPLICATION', title: 'A workspace, with room to think.',
    description: 'Capture, browse ideas, explore connections and revisit their evolution. This is an authentic Arthur Studio interface capture, supplied with the approved website prototype.',
    capability: 'The screenshot is genuine, 1616 × 998 pixels, and includes its original example content. The Infinite Desk is a website metaphor, not a screenshot of an existing spatial application feature.', status: 'Implemented' },
];
export const observations = [
  { title: 'Context changes meaning.', text: 'An open palm can mean hello, stop, or simply rest. Movement alone is not the whole thought.' },
  { title: 'Intention comes first.', text: 'A good interaction might begin with what someone wants to do, rather than a gesture to memorize.' },
  { title: 'Consent is a design material.', text: 'Understanding a gesture should not mean observing everything. What would a deliberate invitation look like?' },
] as const;
export const wordings = [initialThought, 'What if an interface understood the intention behind a gesture—not just its movement?'] as const;
