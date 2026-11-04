import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Hard cap of the Director guide, in UTF-8 bytes. The installed asset is rejected when it is larger. */
export const DIRECTOR_GUIDE_MAX_BYTES = 16 * 1024;
/** Logical name returned to the model; never a machine path. */
export const DIRECTOR_GUIDE_SOURCE = "agents/director/system-prompt.md";

/**
 * `director` means the prompt is the Director's own guide and is returned as is.
 * `coordinator_v2` means the legacy Coordinator guide, which the tool wraps with the "skip pane/Herdr/Conversation" prefix.
 */
export type DirectorGuideFraming = "director" | "coordinator_v2";
export interface DirectorGuide {
  readonly source: string;
  readonly prompt: string;
  readonly framing: DirectorGuideFraming;
}

/** Installed asset next to the other role prompts. It is not a pane-manager role prompt and has no AgentRole profile. */
const GUIDE_URL = new URL("../../../../agents/director/system-prompt.md", import.meta.url);

/** Reads the canonical Director guide from the installed package, never from the user's repository. */
export async function readDirectorGuide(url: URL = GUIDE_URL): Promise<DirectorGuide> {
  let file;
  try {
    file = await open(url, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > DIRECTOR_GUIDE_MAX_BYTES) {
      throw new Error(`the Director guide must be a regular file of at most ${DIRECTOR_GUIDE_MAX_BYTES} bytes`);
    }
    const prompt = await file.readFile("utf8");
    if (!prompt.trim()) throw new Error("the Director guide is empty");
    if (Buffer.byteLength(prompt, "utf8") > DIRECTOR_GUIDE_MAX_BYTES) {
      throw new Error(`the Director guide exceeds ${DIRECTOR_GUIDE_MAX_BYTES} bytes`);
    }
    return { source: DIRECTOR_GUIDE_SOURCE, prompt, framing: "director" };
  } catch (error) {
    throw new Error(
      `Cannot load the Director guide. Rebuild/reinstall the complete Bflow package, including agents/. ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    await file?.close();
  }
}

export interface DirectorGuideSourceOptions {
  /** True in a Director session layout; false for legacy v2 sessions that still use the Coordinator guide. */
  readonly directorLayout: boolean;
  /** Legacy Coordinator guide (v2 sessions). */
  readonly readCoordinatorGuide: () => Promise<{ source: string; prompt: string }>;
  /** Defaults to the installed Director guide. */
  readonly readDirectorGuide?: () => Promise<DirectorGuide>;
}

/**
 * `read_coordinator_guide` keeps its name and wire shape: it returns the Director guide in the Director layout and the
 * unchanged Coordinator guide for v2. The two never mix, so a v2 session keeps its exact historical text.
 */
export function createDirectorGuideSource(options: DirectorGuideSourceOptions): () => Promise<DirectorGuide> {
  return async () => {
    if (options.directorLayout) return (options.readDirectorGuide ?? readDirectorGuide)();
    const legacy = await options.readCoordinatorGuide();
    return { source: legacy.source, prompt: legacy.prompt, framing: "coordinator_v2" };
  };
}
