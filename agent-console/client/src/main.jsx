import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.jsx";
import { ToastProvider } from "./components/Toast.jsx";
import { TooltipProvider } from "./components/ui/tooltip.jsx";
import { ThemeProvider } from "./theme.jsx";

/*
 * Aileron is the only typeface in this application — interface, labels, numerals
 * and code all share it, so the whole product reads as one voice.
 *
 * Self-hosted rather than fetched from a CDN. An operator on a restricted network
 * gets the real face instead of degrading to a platform font, and there is no
 * third-party request on first paint.
 *
 * Only the four weights the design system actually names are loaded, and they are
 * the four Aileron genuinely ships in this range — 300/400/600/700. Aileron has no
 * 500, so `font-medium` is mapped onto 600 in tailwind.config.js; importing a
 * weight the family does not contain would hand the browser a synthesised
 * (smeared) face instead. Keep this list and the `fontWeight` theme in step.
 */
import "@fontsource/aileron/latin-300.css";
import "@fontsource/aileron/latin-400.css";
import "@fontsource/aileron/latin-400-italic.css";
import "@fontsource/aileron/latin-600.css";
import "@fontsource/aileron/latin-700.css";

import "./styles.css";

/**
 * Radix needs one TooltipProvider above every tooltip in the tree — it owns the
 * shared hover delay, so a pointer moving between two controls does not restart
 * the timer.
 *
 * Nothing here has to be told about routing: a Button becomes a link through
 * `asChild` wrapping react-router's own <Link>, so the component layer never needs
 * a `navigate` function handed to it.
 *
 * Toasts sit inside the theme provider so they inherit the palette, and outside the
 * router's page tree so a toast survives the navigation that triggered it.
 */
function Providers({ children }) {
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={200} skipDelayDuration={300}>
        <ToastProvider>{children}</ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

// Mount once in development as well as production. StrictMode's development-only
// remount replays every page's loading effect and sends duplicate API reads.
createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <Providers>
      <App />
    </Providers>
  </BrowserRouter>,
);
