import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LanguageGate } from "./components/LanguagePicker";
import { bootTheme, SettingsProvider } from "./settings";
import "./styles.css";

bootTheme();

// Load settings before the first render so the UI doesn't flash in the wrong language.
void window.farm.settings.get().then((settings) => {
  createRoot(document.getElementById("root")!).render(
      <SettingsProvider initial={settings}>
        <LanguageGate>
          <App />
        </LanguageGate>
      </SettingsProvider>
  );
});
