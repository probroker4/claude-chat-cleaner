# Claude Chat Cleaner

Delete your Claude Code chats without digging through files.

Claude Code saves every conversation under `~/.claude/projects/` as files with names like `503edb05-8fad-408f-b073-f65c66d1919d.jsonl`. Deleting one normally means finding the right UUID by hand.

This plugin adds four slash commands for that instead:

| Command | What it does |
| --- | --- |
| `/claude-chat-cleaner:list` | Shows your chats for the current folder with titles, dates and sizes. `/claude-chat-cleaner:list all` covers every folder. |
| `/claude-chat-cleaner:delete` | Choose chats by number or description. Claude confirms, then moves them to the trash. |
| `/claude-chat-cleaner:restore` | Brings chats back from the trash. |
| `/claude-chat-cleaner:empty-trash` | Deletes chats in the trash for good. |

Deleting always goes to a trash folder first, and the chat you're currently in can never be deleted.

## Example

```
> /claude-chat-cleaner:delete the empty ones and anything about the weather app

  #  Title                                   Last active   Size    Prompts
  1  Fix flaky login test                     3 days ago    312 KB  15
  2  Weather app: add hourly forecast         6 days ago    438 KB  4
  3  Weather app: fix dark mode colors        11 days ago   295 KB  2
  4  (no messages)                           17 days ago   267 B   0   (empty)

  I'll move 2, 3 and 4 to the trash.
  ❯ Yes, delete them
    No, cancel

  Moved 3 chats to the trash. You can restore them for 30 days with /claude-chat-cleaner:restore.
```

You can describe what to delete in plain words: `3 5-7`, `the empty ones`, `older than a month`, `the weather app ones`.

## Install

Inside Claude Code:

```
/plugin marketplace add probroker4/claude-chat-cleaner
/plugin install claude-chat-cleaner@claude-chat-cleaner
```

Then restart Claude Code.

**Needs:** Node.js 18 or newer on your `PATH`. It works on macOS, Linux and Windows.

## What gets deleted

For a chat with id `<id>`, the plugin moves these into `~/.claude/chat-trash/<id>/`:

| Original location | What it is |
| --- | --- |
| `~/.claude/projects/<folder>/<id>.jsonl` | The conversation |
| `~/.claude/projects/<folder>/<id>/` | Subagent transcripts and saved tool output |
| `~/.claude/file-history/<id>/` | File snapshots used by rewind |
| `~/.claude/session-env/<id>/` | Session environment |
| Lines in `~/.claude/history.jsonl` for this chat | Your prompt history (what the up arrow recalls) |

A `manifest.json` in each trash folder records where everything came from, so `/claude-chat-cleaner:restore` can put it back exactly.

It doesn't touch anything else. Your code, your `CLAUDE.md` files, your settings and your other chats stay as they are.

## The trash

- Chats stay in the trash for **30 days**. After that, any claude-chat-cleaner command removes them for good.
- To change that, set `CLAUDE_CHAT_CLEANER_TRASH_DAYS` in your environment or in the `env` section of `~/.claude/settings.json`. `0` keeps them forever.
- `/claude-chat-cleaner:empty-trash` removes them right away.

## Using it without Claude

The skills are thin wrappers around one dependency-free script, which you can also run yourself:

```bash
node ~/.claude/plugins/cache/claude-chat-cleaner/claude-chat-cleaner/*/scripts/claude-chat-cleaner.mjs --help

node claude-chat-cleaner.mjs list [--all]
node claude-chat-cleaner.mjs delete <id-or-prefix> ...
node claude-chat-cleaner.mjs trash
node claude-chat-cleaner.mjs restore <id-or-prefix> ...
node claude-chat-cleaner.mjs empty-trash [--older-than N]
```

Every command takes `--json`. The script respects `CLAUDE_CONFIG_DIR` if you've moved your Claude Code config folder.

## Safety

- The current chat is never deleted. Claude Code passes its id to the script (`${CLAUDE_SESSION_ID}` in the skill, `CLAUDE_CODE_SESSION_ID` in the environment). If neither is available, the script protects the most recently active chat in the folder.
- A delete checks every id first. If any id is unknown, ambiguous or protected, nothing is moved.
- `history.jsonl` is rewritten through a temporary file and an atomic rename.
- A restore won't overwrite a file that already exists, and it only writes to paths inside your Claude config folder.
- If you delete a chat that's still open in *another* Claude Code window, that window may keep writing to it. Close it first.

## Uninstall

```
/plugin uninstall claude-chat-cleaner@claude-chat-cleaner
/plugin marketplace remove claude-chat-cleaner
```

Anything still in `~/.claude/chat-trash/` stays there until you delete that folder.

## Development

```bash
git clone https://github.com/probroker4/claude-chat-cleaner
cd claude-chat-cleaner
npm test                                  # no dependencies to install
claude --plugin-dir .                     # try the plugin without installing it
CLAUDE_CONFIG_DIR=/tmp/fake node scripts/claude-chat-cleaner.mjs list --all   # point it at a test folder
```

Claude Code's on-disk format isn't a public API and may change. If something looks wrong after a Claude Code update, please open an issue.

## License

[MIT](LICENSE). This is a community plugin and isn't affiliated with or endorsed by Anthropic.
