import { ManagedToolPinSchema, type ManagedToolPin } from "./installer.js";

/** Fixed release artifacts downloaded and checked against upstream checksums/SRI on 2026-10-18.
 * Updating requires downloading the new artifact and reviewing its license and install behavior.
 * Catalog selection is read-only; it never queries a floating release channel at runtime. */
export const DEFAULT_INSTALLER_ID = "bflow-default-tools-v1";
export interface ManualToolRequirement { toolId: string; documentation: string; diagnostic: string }
interface CatalogPin { platform?: string; arch?: string; pin: ManagedToolPin }
const reviewed: CatalogPin[] = [
  {
    "pin": {
      "toolId": "codex",
      "version": "0.163.0",
      "source": "https://registry.npmjs.org/@openai/codex/-/codex-0.163.0.tgz",
      "integrity": "1a71db36560bb446d2c2e63ae675c4a3018c38ace38ca533f8d1b25d3e6555b4",
      "license": "Apache-2.0",
      "recipe": {
        "kind": "npm",
        "packageName": "@openai/codex",
        "executable": "codex",
        "allowBuildScripts": false
      },
      "installerId": "bflow-default-tools-v1"
    }
  },
  {
    "pin": {
      "toolId": "claude",
      "version": "2.1.302",
      "source": "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.302.tgz",
      "integrity": "ac1a6a3364c467392bc40a8a405490e821575e3e858d3013b11258862c01dfc8",
      "license": "SEE LICENSE IN README.md",
      "recipe": {
        "kind": "npm",
        "packageName": "@anthropic-ai/claude-code",
        "executable": "claude",
        "allowBuildScripts": true
      },
      "installerId": "bflow-default-tools-v1"
    }
  },
  {
    "pin": {
      "toolId": "chrome-devtools-mcp",
      "version": "1.11.0",
      "source": "https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-1.11.0.tgz",
      "integrity": "e9f0ab97ad9515927c7d9f0a3dfbdb9ea485d2810d572e4a64eb84b192c8bf0c",
      "license": "Apache-2.0",
      "recipe": {
        "kind": "npm",
        "packageName": "chrome-devtools-mcp",
        "executable": "chrome-devtools-mcp",
        "allowBuildScripts": false
      },
      "installerId": "bflow-default-tools-v1"
    }
  },
  {
    "pin": {
      "toolId": "gitnexus",
      "version": "1.6.12",
      "source": "https://registry.npmjs.org/gitnexus/-/gitnexus-1.6.12.tgz",
      "integrity": "96391a6d66d448bf0978084951e9cee37e543b75e445cf9ad2cd1358d7d141e1",
      "license": "PolyForm-Noncommercial-1.0.0",
      "recipe": {
        "kind": "npm",
        "packageName": "gitnexus",
        "executable": "gitnexus",
        "allowBuildScripts": true
      },
      "installerId": "bflow-default-tools-v1"
    }
  },
  {
    "platform": "linux",
    "arch": "arm64",
    "pin": {
      "toolId": "rtk",
      "version": "1.0.1",
      "source": "https://github.com/rtk-ai/rtk/releases/download/v1.0.1/rtk-aarch64-unknown-linux-gnu.tar.gz",
      "integrity": "cd627c4091ad90b5e5aca83ca5af66ee4b8aa8537a736533fa90544f461f1c2b",
      "license": "MIT AND BUSL-1.1 (rtk-engine; see LICENSE-ENGINE)",
      "recipe": {
        "kind": "rtk_archive",
        "archiveMember": "rtk"
      },
      "installerId": "bflow-default-tools-v1"
    }
  },
  {
    "platform": "darwin",
    "arch": "arm64",
    "pin": {
      "toolId": "rtk",
      "version": "1.0.1",
      "source": "https://github.com/rtk-ai/rtk/releases/download/v1.0.1/rtk-aarch64-apple-darwin.tar.gz",
      "integrity": "4aae2f60cfc49c9e81b8c8c57020aa0cb824da608c78b4f0cf5c0988e19e824e",
      "license": "MIT AND BUSL-1.1 (rtk-engine; see LICENSE-ENGINE)",
      "recipe": {
        "kind": "rtk_archive",
        "archiveMember": "rtk"
      },
      "installerId": "bflow-default-tools-v1"
    }
  },
  {
    "platform": "linux",
    "arch": "x64",
    "pin": {
      "toolId": "rtk",
      "version": "1.0.1",
      "source": "https://github.com/rtk-ai/rtk/releases/download/v1.0.1/rtk-x86_64-unknown-linux-musl.tar.gz",
      "integrity": "5b919c3bccb799b67a61866d0e617410a4fcdf173e2614440e59de2fa2003436",
      "license": "MIT AND BUSL-1.1 (rtk-engine; see LICENSE-ENGINE)",
      "recipe": {
        "kind": "rtk_archive",
        "archiveMember": "rtk"
      },
      "installerId": "bflow-default-tools-v1"
    }
  },
  {
    "platform": "darwin",
    "arch": "x64",
    "pin": {
      "toolId": "rtk",
      "version": "1.0.1",
      "source": "https://github.com/rtk-ai/rtk/releases/download/v1.0.1/rtk-x86_64-apple-darwin.tar.gz",
      "integrity": "4b716b2f45d677de41c99f77d9a71199ad060b98ec2f78ef712885312b3a6578",
      "license": "MIT AND BUSL-1.1 (rtk-engine; see LICENSE-ENGINE)",
      "recipe": {
        "kind": "rtk_archive",
        "archiveMember": "rtk"
      },
      "installerId": "bflow-default-tools-v1"
    }
  },
  {
    "platform": "linux",
    "arch": "x64",
    "pin": {
      "toolId": "agy",
      "version": "1.4.0",
      "source": "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.0-5281842794987520/linux-x64/cli_linux_x64.tar.gz",
      "integrity": "fd96967583c1eed94733c039638fa59b71ddbd823c75ebc8dd0e677463565aad",
      "license": "Proprietary",
      "recipe": {
        "kind": "binary_archive",
        "archiveMember": "antigravity",
        "executable": "agy"
      },
      "installerId": "bflow-default-tools-v1"
    }
  },
  {
    "platform": "linux",
    "arch": "x64",
    "pin": {
      "toolId": "herdr",
      "version": "0.9.5",
      "source": "https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-x86_64",
      "integrity": "14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d",
      "license": "MIT",
      "recipe": {
        "kind": "binary",
        "executable": "herdr"
      },
      "installerId": "bflow-default-tools-v1"
    }
  },
  {
    "platform": "darwin",
    "arch": "x64",
    "pin": {
      "toolId": "herdr",
      "version": "0.9.5",
      "source": "https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-macos-x86_64",
      "integrity": "5fb0a908ec7f6745e3e245738b06bfad56c46391c391ab3c0955fbead01f1369",
      "license": "MIT",
      "recipe": {
        "kind": "binary",
        "executable": "herdr"
      },
      "installerId": "bflow-default-tools-v1"
    }
  },
  {
    "platform": "linux",
    "arch": "arm64",
    "pin": {
      "toolId": "herdr",
      "version": "0.9.5",
      "source": "https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-aarch64",
      "integrity": "17d7536f2da50859523680ef279dffcac8e4a235f4e46fe8da6c2ec44141897c",
      "license": "MIT",
      "recipe": {
        "kind": "binary",
        "executable": "herdr"
      },
      "installerId": "bflow-default-tools-v1"
    }
  },
  {
    "platform": "darwin",
    "arch": "arm64",
    "pin": {
      "toolId": "herdr",
      "version": "0.9.5",
      "source": "https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-macos-aarch64",
      "integrity": "fb77c2232a05a8035421382c894392f4174e4e38a18e48af3dd0290157c3a7e2",
      "license": "MIT",
      "recipe": {
        "kind": "binary",
        "executable": "herdr"
      },
      "installerId": "bflow-default-tools-v1"
    }
  }
];

const nativeManual: ManualToolRequirement[] = [
  { toolId: "mempalace", documentation: "https://pypi.org/project/mempalace/",
    diagnostic: "Install with python3 -m venv ~/.mempalace-venv && ~/.mempalace-venv/bin/pip install mempalace, register the MCP server with claude mcp add --scope user mempalace -- ~/.mempalace-venv/bin/mempalace-mcp, then verify mempalace status and that the MCP server connects. Bflow does not install or configure MemPalace automatically and never treats its presence as task evidence." },
  { toolId: "superpowers", documentation: "https://github.com/obra/superpowers#Getting-Started",
    diagnostic: "Use Claude Code /plugin install superpowers@claude-plugins-official, Codex /plugins then search Superpowers, or agy plugin install https://github.com/obra/superpowers. Then verify the exact enabled plugin, marketplace provenance and active using-superpowers skill. Bflow cannot infer native activation from a downloaded archive or modify provider settings automatically." }
];
export function defaultToolCatalog(os: string, arch: string): { pins: ManagedToolPin[]; manual: ManualToolRequirement[] } {
  const supported = (os === "linux" || os === "darwin") && (arch === "x64" || arch === "arm64");
  const pins = supported ? reviewed.filter(item => !item.platform || (item.platform === os && item.arch === arch))
    .map(item => ManagedToolPinSchema.parse(item.pin)) : [];
  const manual = nativeManual.map(item => ({ ...item }));
  if (!pins.some(pin => pin.toolId === "agy")) manual.push({ toolId: "agy",
    documentation: "https://antigravity.google/docs/cli/install/",
    diagnostic: "No reviewed Agy artifact for this OS/architecture. Install the official native CLI, verify agy --version, and complete agy login; Bflow never substitutes Gemini CLI." });
  if (!supported) for (const toolId of ["rtk", "gitnexus", "chrome-devtools-mcp", "claude", "codex", "herdr"]) {
    const documentation: Record<string, string> = {
      rtk: "https://github.com/rtk-ai/rtk/blob/develop/INSTALL.md",
      gitnexus: "https://github.com/abhigyanpatwari/GitNexus",
      "chrome-devtools-mcp": "https://github.com/ChromeDevTools/chrome-devtools-mcp",
      claude: "https://code.claude.com/docs/en/setup",
      codex: "https://github.com/openai/codex",
      herdr: "https://herdr.dev/docs/install/"
    };
    manual.push({ toolId, documentation: documentation[toolId]!,
      diagnostic: `No reviewed automatic ${toolId} installer for ${os}/${arch}; use the tool's official platform instructions and rerun bflow setup --check.` });
  }
  return { pins, manual };
}

/** Native archives are inputs to the Bflow-owned, policy-preserving provider runtime. */
export function defaultNativeToolPins(): ManagedToolPin[] {
  return [
    { toolId: "superpowers", installerId: "bflow-native-superpowers-v1", version: "7.0.0",
      source: "https://github.com/obra/superpowers/archive/refs/tags/v7.0.0.tar.gz",
      integrity: "b1fa757963ba9817035e77b3039518bca95fd250684d49299616fa2676f5baee",
      license: "MIT", recipe: { kind: "provider_plugin", provider: "codex" } }
  ].map(pin => ManagedToolPinSchema.parse(pin));
}
