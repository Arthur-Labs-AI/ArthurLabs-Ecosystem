import { CaptureDialog } from "../features/capture/CaptureDialog";
import { ConnectionsScreen } from "../features/graph/ConnectionsScreen";
import { HomeScreen } from "../features/home/HomeScreen";
import { IdeasScreen } from "../features/ideas/IdeasScreen";
import { EvolutionScreen } from "../features/lineage/EvolutionScreen";
import { MobileApp } from "../features/mobile/MobileApp";
import { AskScreen } from "../features/recall/AskScreen";
import { SetupFlow } from "../features/setup/SetupFlow";
import { useAiConfig } from "../features/setup/ai-config-context";
import { SettingsScreen } from "../features/settings/SettingsScreen";
import { useArthurClient } from "../hooks/use-arthur-client";
import { useLayoutMode } from "./layout-mode";
import { useNavigation } from "./navigation";
import { Shell } from "./Shell";

/** Marginalia Desktop: the rail and the three-region screens. Unchanged by the mobile shell. */
function DesktopApp() {
  const { screen } = useNavigation();
  return (
    <Shell>
      {screen === "home" && <HomeScreen />}
      {screen === "ideas" && <IdeasScreen />}
      {screen === "connections" && <ConnectionsScreen />}
      {screen === "evolution" && <EvolutionScreen />}
      {screen === "ask" && <AskScreen />}
      {screen === "settings" && <SettingsScreen />}
      <CaptureDialog />
    </Shell>
  );
}

/**
 * One application, two presentations. Both read the same client, hooks, contracts and navigation state, so resizing
 * a window across the breakpoint keeps the user's place; only the presentation changes.
 */
export function App() {
  const mobile = useLayoutMode() === "mobile";
  const ai = useAiConfig();
  const client = useArthurClient();
  // First run: Setup comes before anything else. While the native configuration is still being read nothing is drawn, so the app
  // never flashes before Setup. (The in-memory preview client answers in the same tick, so it draws straight away.) If the
  // configuration cannot be read at all, Arthur opens normally and every capability reports its own state.
  if (ai.status === "loading" && client.kind !== "preview") return null;
  if (ai.status === "ready" && ai.config && !ai.config.setupCompleted) return <SetupFlow />;
  return mobile ? <MobileApp /> : <DesktopApp />;
}
