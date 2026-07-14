import "./state/store-instance.ts";

import { TooltipProvider } from "@t4-code/ui";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import type { Root } from "react-dom/client";

import { router } from "./router.tsx";

export function renderApplication(root: Root): void {
  root.render(
    <StrictMode>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </StrictMode>,
  );
}
