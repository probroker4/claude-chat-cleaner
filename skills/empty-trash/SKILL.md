---
name: empty-trash
description: Permanently delete Claude Code chats that are in the chats trash folder. Only run when the user invokes /chats:empty-trash.
argument-hint: "[older-than days | chat numbers]"
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

# Empty the chat trash

This permanently deletes chats. It can't be undone.

## 1. Show the trash

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/chats.mjs" trash --json
```

If `trash` is empty, say so and stop. Otherwise show a table with these columns: `#`, Title, Deleted and Days left.

## 2. Work out the scope

From "$ARGUMENTS":
- nothing: every chat in the trash
- "older than N days": pass `--older-than N`
- numbers or titles: those chats only, passed by full `id`

## 3. Confirm

Say how many chats will be permanently deleted and list them. Then use the AskUserQuestion tool:
- question: "Permanently delete these N chat(s)? This can't be undone."
- options: "Yes, delete forever" and "No, keep them"

Only continue if they choose "Yes, delete forever".

## 4. Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/chats.mjs" empty-trash [<id> ...] [--older-than N] --json
```

Report how many chats were removed (`removed`).
