---
name: delete
description: Delete Claude Code chats by moving them to a trash folder, after the user confirms. Only run when the user invokes /chats:delete.
argument-hint: "[which chats, e.g. \"3 5-7\", \"empty ones\", \"older than 30 days\", \"all\" for every project]"
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

# Delete chats

The user wants to delete some of their Claude Code chats. Deleted chats go to a trash folder and can be restored with `/chats:restore`.

## 1. List the chats

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/chats.mjs" list --json --current "${CLAUDE_SESSION_ID}"
```

Add `--all` if the user's request ("$ARGUMENTS") mentions every project or folder, or names chats that aren't in this folder. If the output has `"ok": false`, show the `error` and stop.

## 2. Work out which chats they mean

- If "$ARGUMENTS" already says which chats (numbers such as `3 5-7`, "the empty ones", "older than a month", words from a title), match them against the list.
- Otherwise show the numbered table (`#`, Title, Last active, Size, Prompts, and Project when listing all) and ask which ones to delete. The user can answer with numbers, ranges or a description. Wait for their answer.
- Never pick the chat marked `current`: this conversation can't delete itself. If they ask for it, say so and leave it out.
- If the request is unclear, ask. Don't guess.

## 3. Confirm

Show exactly the chats that will be deleted (number, title, last active), then use the AskUserQuestion tool:
- question: "Move these N chat(s) to the trash?"
- options: "Yes, delete them" and "No, cancel"

If any chosen chat has `recentlyActive: true`, warn that it may be open in another Claude Code window, where it would keep writing.

Only continue if they choose "Yes, delete them".

## 4. Delete

Pass the full `id` of each chosen chat:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/chats.mjs" delete <id> <id> ... --json --current "${CLAUDE_SESSION_ID}"
```

If `ok` is false, show the error. Nothing was deleted in that case.

## 5. Report

List what was moved to the trash. If `trashDays` is above 0, say the chats stay restorable for `trashDays` days with `/chats:restore`. If it is 0, say they can be restored any time. If `purged` is not empty, mention that older chats that had been in the trash too long were removed for good.
