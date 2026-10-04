import { CaptureDialog } from "../features/capture/CaptureDialog";
import { ConnectionsScreen } from "../features/graph/ConnectionsScreen";
import { HomeScreen } from "../features/home/HomeScreen";
import { IdeasScreen } from "../features/ideas/IdeasScreen";
import { EvolutionScreen } from "../features/lineage/EvolutionScreen";
import { SettingsScreen } from "../features/settings/SettingsScreen";
import { useNavigation } from "./navigation";
import { Shell } from "./Shell";

export function App() {
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
