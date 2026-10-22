export const information = [
  { id:'idea', thought:'An offline-first task manager.', plan:'Project context', detail:'One idea. A clear starting point.', final:'Offline-first task manager' },
  { id:'storage', thought:'Keep tasks on this device.', plan:'Local persistence', detail:'Storage layer', final:'Task data stays local' },
  { id:'interaction', thought:'Create. Complete. Organize.', plan:'Task lifecycle', detail:'Interaction layer', final:'Capture & complete tasks' },
  { id:'boundary', thought:'No account. No connection.', plan:'Privacy constraint', detail:'Data boundary', final:'Offline-first constraint' },
  { id:'review', thought:'Make the work reviewable.', plan:'Review requirements', detail:'Review package', final:'For later independent QA' },
  { id:'coordination', thought:'Give the idea structure.', plan:'Structured requirements', detail:'Orchestration', final:'Coordinate the conceptual work' },
] as const;
export const beats = [
  { label:'01 / CAPTURE', title:'Everything starts with a thought.', text:'An offline-first task manager. One captured intention, before the work has a shape.' },
  { label:'02 / CONNECT', title:'A thought finds its connections.', text:'Local data. Everyday interactions. Clear constraints. The relationships become visible.' },
  { label:'03 / STRUCTURE', title:'Connections become a plan.', text:'The same information reorganizes into requirements. Nothing loses its context.' },
  { label:'04 / ORCHESTRATE', title:'Context becomes coordinated work.', text:'The structured brief enters Nexus. Requirements become the context for conceptual orchestration.' },
] as const;
export const beatPositions = [.06,.37,.61,.95] as const;
export function beatFor(p:number) { return p < .22 ? 0 : p < .50 ? 1 : p < .75 ? 2 : 3; }
