import { CapturePanel } from "../features/capture/CapturePanel";
import { GraphPanel } from "../features/graph/GraphPanel";
import { KnowledgePanel } from "../features/knowledge/KnowledgePanel";
import { RuntimePanel } from "../features/settings/RuntimePanel";
import { AppLayout } from "./layout";

export function App() {
  return (
    <AppLayout>
      <CapturePanel />
      <KnowledgePanel />
      <GraphPanel />
      <RuntimePanel />
    </AppLayout>
  );
}
