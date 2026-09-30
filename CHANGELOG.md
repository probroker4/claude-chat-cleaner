# Changelog

## 0.1.0 (2026-09-30)

- First release.
- `/claude-chat-cleaner:list`, `/claude-chat-cleaner:delete`, `/claude-chat-cleaner:restore` and `/claude-chat-cleaner:empty-trash`.
- Deleted chats go to `~/.claude/chat-trash/` and are removed for good after 30 days (`CLAUDE_CHAT_CLEANER_TRASH_DAYS`).
