# Changelog

## 0.1.0 (2026-09-30)

- First release.
- `/chats:list`, `/chats:delete`, `/chats:restore` and `/chats:empty-trash`.
- Deleted chats go to `~/.claude/chat-trash/` and are removed for good after 30 days (`CHATS_TRASH_DAYS`).
