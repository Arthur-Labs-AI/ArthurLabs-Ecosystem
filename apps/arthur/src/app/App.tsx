import { CapturePanel } from "../features/capture/CapturePanel";
import { RuntimePanel } from "../features/settings/RuntimePanel";
import { AppLayout } from "./layout";

export function App() {
  return (
    <AppLayout>
      <CapturePanel />
      <RuntimePanel />
    </AppLayout>
  );
}
