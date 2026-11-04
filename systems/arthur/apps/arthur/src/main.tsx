import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ArthurProviders } from "./app/providers";
import { applyStoredTheme } from "./app/theme";
import "./app/styles/index.css";

applyStoredTheme();

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root element");
}

createRoot(container).render(
  <StrictMode>
    <ArthurProviders>
      <App />
    </ArthurProviders>
  </StrictMode>,
);
