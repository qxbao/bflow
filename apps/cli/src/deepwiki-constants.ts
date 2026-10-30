/** Identity of the DeepWiki service the Gateway exposes. Kept in one place in the CLI; the tool-installer owns the endpoint. */
export const DEEPWIKI_SERVICE_ID = "deepwiki";
export const DEEPWIKI_TOOLS: readonly string[] = ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"];
export const DEEPWIKI_ENDPOINT = "https://mcp.deepwiki.com/mcp";
