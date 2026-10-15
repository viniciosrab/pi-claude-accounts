# pi-claude-accounts

Pi extension that registers several Claude Code accounts for [pi-claude-bridge](https://github.com/viniciosrab/pi-claude-bridge) and switches automatically when the active account reaches **95% of its 5-hour window**.

## How it works

claude-bridge spawns a fresh Claude Code CLI per prompt and hands it Pi's environment. Before each prompt this extension sets `CLAUDE_CODE_OAUTH_TOKEN` to the active account's token (the variable takes precedence over `~/.claude/.credentials.json`). Usage comes from the `anthropic-ratelimit-unified-5h-*` headers claude-bridge already emits after every response.

- Switches only between prompts, never mid-response, with no confirmation, and shows a notice: `Claude account switched: a (96%) → b (12%)`.
- Below 95% it stays on the current account. A window whose reset time has passed counts as 0%.
- If every account is at the limit it waits on the one that resets first.
- Usage of an inactive account is unknown until checked. When the active account passes **85%**, the other accounts whose data is missing or older than 10 minutes are checked in the background, so the switch at 95% never lands on an exhausted account. **Refresh usage** in the menu (or `/claude-accounts refresh`) checks all accounts on demand.
- A check runs Claude Code with a one-character Haiku prompt (setup-token tokens are refused by the usage endpoint), takes about 10s and uses a tiny part of each account's limit.
- Only the 5-hour window is considered.
- The footer shows the active account and its 5h usage, e.g. `Claude: work · 5h 42%`, while a claude-bridge model is selected.
- Several Pi instances can run at once: every change re-reads `claude-accounts.json` and writes it atomically, and all of them follow the same active account.

## Install

```
pi install /path/to/pi-claude-accounts   # or add the path to "packages" in ~/.pi/agent/settings.json
```

## Usage

Run `/claude-accounts` with no arguments to open a menu: **List accounts**, **Refresh usage**, **Add**, **Switch** or **Remove** account. Add asks for a name, then for a token from `claude setup-token` (run it logged in to the other account). Switch and Remove show each account with its 5h usage; Remove asks for confirmation.

The login you already have in Claude Code is the `default` account and cannot be removed.

Typing `/claude-accounts ` also completes subcommands, and account names after `use` / `remove`:

```
/claude-accounts add work [token]
/claude-accounts list
/claude-accounts refresh
/claude-accounts use work
/claude-accounts remove work
```

Tokens are stored in `~/.pi/agent/claude-accounts.json` (mode 0600).

## Caveats

- Each switch loses the prompt cache, so the first reply on the new account is slower and costlier.
- Relies on claude-bridge forwarding Pi's environment to the CLI.
- Rotating subscriptions to get around usage limits may conflict with Anthropic's terms.

## Development

`npm test` (Node 22.18+ runs the TypeScript tests directly).
