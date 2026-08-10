import { HeroUIProvider } from "@heroui/react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useHref, useNavigate } from "react-router-dom";
import { App } from "./App.jsx";
import { ThemeProvider } from "./theme.jsx";
import "./styles.css";

/**
 * Handing HeroUI the router's navigate keeps every `href` a client-side
 * transition, so a HeroUI Button or Link behaves like a react-router Link.
 */
function Providers({ children }) {
  const navigate = useNavigate();
  return (
    <HeroUIProvider navigate={navigate} useHref={useHref}>
      <ThemeProvider>{children}</ThemeProvider>
    </HeroUIProvider>
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
