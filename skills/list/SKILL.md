---
name: list
description: List the user's Claude Code chats (sessions) with titles, dates and sizes. Use when the user asks to see, find or browse their past Claude Code chats, conversations or sessions.
argument-hint: "[all]"
allowed-tools: Bash(node:*)
---

# List chats

Run this command. Add `--all` only if the user's arguments ("$ARGUMENTS") ask for every project or folder:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/chat-cleaner.mjs" list --json --current "${CLAUDE_SESSION_ID}"
```

If the output has `"ok": false`, show the `error` and stop. If `node` is not found, tell the user this plugin needs Node.js 18 or newer.

Show the chats as a markdown table with these columns: `#`, Title, Last active (`lastActiveAgo`), Size, Prompts, and Project when `scope` is `all`. Mark the row where `current` is true with "(this chat)", and mark rows where `empty` is true with "(empty)". If there are more than 40 chats, show the 40 newest and say how many more there are.

If `chats` is empty, say that no chats were found for this folder and suggest `/chat-cleaner:list all`.

End with one line: "To delete some, run `/chat-cleaner:delete`."
