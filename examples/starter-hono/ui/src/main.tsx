import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@generic-ai/plugin-web-ui/styles.css";
import "./styles.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Root element #root was not found.");
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
