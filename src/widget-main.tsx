// Phase 10: entry point for the widget window. Mirrors src/main.tsx but
// mounts <Widget /> instead of <App />.

import React from "react";
import ReactDOM from "react-dom/client";
import { Widget } from "./Widget";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Widget />
  </React.StrictMode>,
);
