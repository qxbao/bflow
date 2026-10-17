import type { BundleFiles } from "../src/index.js";
export const body = (name = "example") =>
  `---\nname: ${name}\ndescription: Inspect an assigned task before implementation.\n---\n\n${["Supported roles", "Prerequisites", "Trigger conditions", "Required inputs", "Expected outputs", "Procedure", "Bflow commands", "Verification requirements", "Error handling", "Escalation rules", "Concrete examples"].map((h) => `## ${h}\n\n${h === "Bflow commands" ? "`bflow status`" : "Use the accepted task and preserve Runtime authority."}`).join("\n\n")}\n`;
export const files = (name = "example"): BundleFiles => ({
  "SKILL.md": body(name),
  "skill.json": JSON.stringify({
    version: "1.0.0",
    allowedRoles: ["developer"],
    supportedProviders: ["claude", "codex", "agy"],
    requiredCapabilityIds: [],
    requiredToolIds: [],
    dependencies: [],
  }),
});
