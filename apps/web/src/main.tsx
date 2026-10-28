import { createRoot } from "react-dom/client";
import { WEB_API_VERSION } from "@bflow/contracts/web";

// Build/import smoke only; W06 owns the actual application and visual design.
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<p data-api-version={WEB_API_VERSION}>Bflow local web — W00 build skeleton.</p>);
