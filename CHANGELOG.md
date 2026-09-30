# Changelog

## 0.1.0 (2026-09-30)

- First release.
- `/chat-cleaner:list`, `/chat-cleaner:delete`, `/chat-cleaner:restore` and `/chat-cleaner:empty-trash`.
- Deleted chats go to `~/.claude/chat-trash/` and are removed for good after 30 days (`CHAT_CLEANER_TRASH_DAYS`).
