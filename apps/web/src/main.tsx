import { initializeTheme, ThemeProvider } from "@stonehush/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { queryClient } from "./query-client.js";
import { router } from "./router.js";
import { initializeAppearance, installAppearanceSync } from "./settings/appearance.js";
import "./styles.css";

const rootElement = document.querySelector<HTMLDivElement>("#root");
if (!rootElement) throw new Error("Stonehush root element is missing.");

initializeTheme();
initializeAppearance();
installAppearanceSync();

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
