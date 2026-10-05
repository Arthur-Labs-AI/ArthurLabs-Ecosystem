import { CaptureDialog } from "../features/capture/CaptureDialog";
import { ConnectionsScreen } from "../features/graph/ConnectionsScreen";
import { HomeScreen } from "../features/home/HomeScreen";
import { IdeasScreen } from "../features/ideas/IdeasScreen";
import { EvolutionScreen } from "../features/lineage/EvolutionScreen";
import { MobileApp } from "../features/mobile/MobileApp";
import { SettingsScreen } from "../features/settings/SettingsScreen";
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
  return useLayoutMode() === "mobile" ? <MobileApp /> : <DesktopApp />;
}
