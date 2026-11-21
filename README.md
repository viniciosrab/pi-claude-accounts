# pi-claude-accounts

Pi extension that lets [pi-claude-bridge](https://github.com/viniciosrab/pi-claude-bridge) use several Claude Code accounts. When the active account reaches **95% of its 5-hour limit**, it switches to another one on its own, with no confirmation and no interruption to your work.

## Install

```
pi install git:github.com/viniciosrab/pi-claude-accounts
```

## Set up

In Pi, run `/claude-accounts add <name>` (or `/claude-accounts`, then **Add account**). The browser opens on Claude's sign-in page: sign in to the account you are adding and click **Authorize**. The token is saved on its own; there is nothing to copy or paste.

- The browser signs in with whatever account it is already logged in to. To add a different one, log out of claude.ai first or open the link in a private window (if the browser does not open, the link is shown in Pi).
- If the page shows a code instead of finishing, paste it into the dialog in Pi.
- Esc cancels. If `claude setup-token` gives no token (Claude Code is not installed, or you are not on Linux or macOS), Pi asks you to paste one: run `claude setup-token` logged in to that account and paste what it prints. `/claude-accounts add <name> <token>` adds a token you already have.

The account you are already logged in with in Claude Code is listed too (as `default`); you can rename or remove it. Removing it only stops this extension from listing and using it; Claude Code stays logged in. To bring it back, delete `"loginRemoved": true` from `~/.pi/agent/claude-accounts/accounts.json`. The last account left cannot be removed.

## Commands

Run `/claude-accounts` for a menu, or use the subcommands (they autocomplete):

```
/claude-accounts list                  # 5h and weekly usage and time until reset, per account, soonest weekly reset first
/claude-accounts refresh               # check every account now
/claude-accounts add <name> [token]   # without a token, signs in through the browser
/claude-accounts use <name>
/claude-accounts rename <name> <new-name>
/claude-accounts remove <name>
```

`list` and `refresh` open the accounts in a panel that stays until you close it with Esc, so a status message from another extension cannot wipe the list. Without a UI (print or JSON mode) they print it as a notice.

## How it works

- At 95% or more it switches and shows `Claude account switched: a (96%) → b (12%)`. New messages use the new account.
- If a running task hits the limit anyway, it carries on with the new account instead of stopping (`continuing on "b"`). This relies on Pi's auto-retry, which is on by default.
- Other accounts are checked in the background once the active one passes 85%, so a switch never lands on an exhausted account.
- A token Claude Code rejects is marked `[token rejected, re-add it]` and skipped. **Switch** to it retries it.
- If every account is at its limit, it waits on the one that resets first.
- Only the 5-hour limit is considered. Several Pi windows can run at once. Each window stays on its own account until that account reaches the limit, so one window switching does not reset the prompt cache of the others. A window that has to move, and any new conversation (subagents included), picks a random account with room, favoring the emptier ones, so windows do not pile up on one account and all have to move again when it fills. Each conversation records in its session file the account it runs on (the name, never the token), and a reopened one (`/reload`, `/resume`, `pi --continue`, a fork) goes back to that account so its prompt cache survives, unless it is used up. A conversation with no recorded account starts on the active one. `use` switches the window you run it in; new conversations do not follow it.

## Notes

- Each switch loses the prompt cache, so the first reply on the new account is slower and costlier.
- Every switch is logged to `~/.pi/agent/claude-accounts/switches.jsonl`: both accounts' usage, the context size, and the next three replies on the new account (5h usage and cache tokens), so you can see what a switch cost.
- Tokens are stored in `~/.pi/agent/claude-accounts/accounts.json` (mode 0600, in a 0700 folder). Older versions kept both files in `~/.pi/agent` itself; they are moved into `claude-accounts/` the first time Pi loads the extension. Reload every open Pi window after updating, so none keeps writing to the old place.
- Rotating subscriptions to get around usage limits may conflict with Anthropic's terms.

## Development

`npm test` (Node 22.18+).
