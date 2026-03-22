import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/global.css";

/* StrictMode 会在开发环境双挂载并卸载子树，导致 Web Speech 被 stop → 误报 aborted */
createRoot(document.getElementById("root")!).render(<App />);
