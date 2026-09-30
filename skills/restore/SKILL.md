---
name: restore
description: Restore Claude Code chats from the chats trash folder. Use when the user wants to undo deleting a chat or asks what is in the chat trash.
argument-hint: "[which chats, e.g. \"1\" or \"all\"]"
allowed-tools: Bash(node:*), AskUserQuestion
---

# Restore chats

## 1. Show the trash

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/chats.mjs" trash --json
```

If `trash` is empty, say the trash is empty and stop. Otherwise show a table with these columns: `#`, Title, Project, Deleted (`deletedAgo`) and Days left (`daysLeft`, or "kept" when it is null).

## 2. Pick

If "$ARGUMENTS" already says which chats to restore, use that. Otherwise ask which ones to restore and wait for the answer. If only one chat is in the trash and the user clearly wants it back, you don't need to ask again.

## 3. Restore

Pass the full `id` of each chosen chat:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/chats.mjs" restore <id> <id> ... --json
```

If `ok` is false, show the error. Nothing was restored in that case. The usual cause is a file with the same name already existing where the chat would go back.

When it succeeds, list the restored chats and say they will show up in `/resume` again.
