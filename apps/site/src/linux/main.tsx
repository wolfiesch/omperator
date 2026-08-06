import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./linux.css";
import { LinuxLanding } from "./LinuxLanding.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LinuxLanding />
  </StrictMode>,
);
