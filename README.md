# pi-claude-accounts

Pi extension that lets [pi-claude-bridge](https://github.com/viniciosrab/pi-claude-bridge) use several Claude Code accounts. When the active account reaches **95% of its 5-hour limit**, it switches to another one on its own, with no confirmation and no interruption to your work.

## Install

```
pi install git:github.com/viniciosrab/pi-claude-accounts
```

## Set up

1. For each extra account, log in to it and run `claude setup-token` to get a token.
2. In Pi, run `/claude-accounts`, choose **Add account**, and paste the name and token.

The account you are already logged in with in Claude Code is listed too (as `default`); you can rename it but not remove it.

## Commands

Run `/claude-accounts` for a menu, or use the subcommands (they autocomplete):

```
/claude-accounts list                  # 5h usage and time until reset, per account
/claude-accounts refresh               # check every account now
/claude-accounts add <name> [token]
/claude-accounts use <name>
/claude-accounts rename <name> <new-name>
/claude-accounts remove <name>
```

## How it works

- At 95% or more it switches and shows `Claude account switched: a (96%) → b (12%)`. Subagents and new messages use the new account.
- If a running task hits the limit anyway, it carries on with the new account instead of stopping (`continuing on "b"`). This relies on Pi's auto-retry, which is on by default.
- Other accounts are checked in the background once the active one passes 85%, so a switch never lands on an exhausted account.
- A token Claude Code rejects is marked `[token rejected, re-add it]` and skipped. **Switch** to it retries it.
- If every account is at its limit, it waits on the one that resets first.
- Only the 5-hour limit is considered. Several Pi windows can run at once and share the same active account.

## Notes

- Each switch loses the prompt cache, so the first reply on the new account is slower and costlier.
- Tokens are stored in `~/.pi/agent/claude-accounts.json` (mode 0600).
- Rotating subscriptions to get around usage limits may conflict with Anthropic's terms.

## Development

`npm test` (Node 22.18+).
