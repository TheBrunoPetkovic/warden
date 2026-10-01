import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "@radix-ui/colors/gray-dark.css";
import "@radix-ui/colors/blue-dark.css";
import "@radix-ui/colors/green-dark.css";
import "@radix-ui/colors/amber-dark.css";
import "@radix-ui/colors/red-dark.css";
import "@radix-ui/colors/cyan-dark.css";
import "@radix-ui/colors/iris-dark.css";
import { App } from "./App.jsx";

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
