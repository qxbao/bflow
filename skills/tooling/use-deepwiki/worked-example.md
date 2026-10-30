# use-deepwiki worked example

## Input

A developer must call a public open-source scheduler library and does not remember how it orders retries after a failure. The library is `acme-labs/scheduler`, which the developer has confirmed is a public GitHub repository.

## Authorized steps

1. `bflow docs structure --repo acme-labs/scheduler --public --json` lists the topics DeepWiki holds, and shows a "Retry and backoff" page.
2. `bflow docs ask --repo acme-labs/scheduler --public --question "How does the scheduler order retries after a task fails?" --json`.
3. The result names the repository, the tool `ask_wiki_question` and the retrieval time. The developer notes that DeepWiki describes the default branch, then opens the installed package's type definitions, confirms the option name, and runs the existing test that exercises a failing task.

## Expected output and evidence

The task note cites the repository and retrieval time of the excerpt, states that the behavior was confirmed by the installed types and a passing test, and treats the documentation as reference rather than authority over the accepted specification.

## Failure branch

If the result is `library_not_found`, the repository may be private or not yet indexed. The developer does not guess another name and does not paste code into a question. The note records that documentation was not available, the decision to rely on the installed package and its tests instead, and the gap. If the service is unreachable, the developer reports that documentation was not checked and continues from repository sources. No question includes repository code, and no unapproved search tool is used instead.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.
