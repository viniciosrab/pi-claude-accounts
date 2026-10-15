# claude-accounts
Pi extension: several Claude Code accounts for claude-bridge, automatic switch at 95% of the 5h window.
Bridge facts: CLI spawned per run and kept across its tool calls (L11), inherits process.env; CLAUDE_CODE_OAUTH_TOKEN beats ~/.claude/.credentials.json; rate_limit_event arrives every request.

## Specs
- S1: "Só o limite de 5 horas" — only the five_hour window drives switching.
- S2: "Eu usei 95% Tem 5% restante Você já vai fazer a troca" — switch when active account utilization >= 0.95.
- S3: "A troca é automática Sem pedir conformação nenhuma" + "Pode até Botar um aviso" — no confirmation, notify on switch.
- S4: "Já vai estar cadastrado" — accounts registered via /claude-accounts add|list|remove|use|status, stored 0600.
- S5: "Enquanto eu for usando Se não tiver batido O limite ... Ele vai continuar na conta" — stay on the current account below threshold.
- S6: "às vezes a troca não ocorre, quando está, por exemplo, 5% dos restantes" — switch at 95% also in the middle of a long run (subagents, many tool turns), not only at the next prompt.
- S7: "quando a troca ocorre ... em vez de continuar o trabalho normalmente, mesmo com a troca, o agente é abortado ... isso não pode acontecer, não pode" — a run (parent or subagent) that hits the limit continues on the new account instead of stopping.

## Tasks
- T1 (S2,S5) pure policy pickAccount + tests — inline — commit: e66b3ed
- T2 (S4) store (0600) + tests — inline — commit: 0a2aef6
- T3 (S1,S3,S4) extension wiring: usage capture, env switch, notify, commands — inline — commit: e27c33b
- T4 docs README — inline — commit: e27c33b
- T5 (S4, L3) TUI menu + / argument completions + tests — inline — commit: f969b33
- T6 (S4, L4) strip whitespace from pasted/stored tokens + tests — inline — commit: 770a1c3
- T7 (S2, L5) probe other accounts (prefetch at 85%, menu refresh) + tests — inline — commit: 9621112
- T8 (L6) store re-read before every write, atomic rename + tests — inline — commit: 0617976
- T9 (L6) footer status: active account + 5h usage + tests — inline — commit: 209edfd
- T10 (L6) lighter probe flags; skip and switch away from accounts whose token is rejected + tests — inline — commit: 3379447
- T11 (S7, L11) on a limit/refused-token failure switch and reword it so Pi auto-retries on the new account + tests — inline — commit: 792890c
- T12 (S6, L11) switch from after_provider_response mid-run; attribute usage to the running process's account + tests — inline — commit: 792890c
- T13 (S6,S7, L12) verify findings: runAccount after other retried errors and renames, no retry promised past Pi's budget, more limit wordings, subagents keep the user's own exported token + tests — inline — commit: 792890c

## Log
L1: Vamos criar agora um plugin... extensão aqui para o Pi... várias contas minhas do Claude Code. Quando chegar 95% do limite de 5 horas, automaticamente troca para outra conta... Sem pedir confirmação... Pode até botar um aviso aqui no Pi que foi trocado... uso o CloudBridge... analisar o CloudBridge.
L2: "go" (analysis), "go" (implement; probes confirmed env token wins, event per request, real token works).
L3: "nao gostei dessa forma pouco pratica tem que ser pela tui do pi" / "tem que criar a opcoes de / para eu poder fazer" — T5: TUI menu + argument completions.
L4: added 4 accounts; probes showed every pasted token had an embedded space (terminal wrap) -> "Not logged in". T6: strip whitespace on add and on load.
L5: "corrigir" — check other accounts usage before switching. Usage endpoint and direct API refuse setup-token tokens (401); probe via Claude Code CLI + Haiku works, ~14s for 5 accounts. T7.
L6: review "oque acha da extensao" -> "go" on: concurrency between Pi instances, footer status, lighter probe + switch on auth failure.
    Probe flags --setting-sources= --strict-mcp-config --tools= --no-session-persistence --disable-slash-commands: 8.9s -> 1.8s, no hooks, no session files, five_hour still reported. --bare unusable (ignores OAuth).
    Bridge auth failure reaches Pi as assistant message_end stopReason "error", errorMessage "Failed to authenticate. API Error: 401 OAuth access token is invalid."; malformed token: "Not logged in · Please run /login".
L7: "so quero que exiba o nome da conta ativa so isso" (footer showed "Claude: default · 5h 23%") — footer now shows only the account name.
L8: "so mude na extensao para vinicios10 a default" — login account is now recognised by having no token; added rename; renamed default -> vinicios10.
L9: "tire do rodape ... so preciso ver a mensagem quando a troca ocorrer" — footer status removed; switch and rejected-token notifications kept.
L10: "precisa colocar quanto tempo falta pro reset do limit de 5 hr" — list shows "resets in Xh Ym".
L11: "percebi que na extensão, eu percebi que às vezes a troca não ocorre, quando está, por exemplo, 5% dos restantes ocorrem, enfim, não sei, tem que verificar isso, e quando ela ocorre, por exemplo, estou trabalhando com subagente ou alguma, trabalhando ali no PIN, e quando a troca ocorre, em vez de continuar o trabalho normalmente, mesmo com a troca, o agente é abortado, ele para com a troca, isso não pode acontecer, não pode." Screenshots: subagent "assistant reported an error" after 12m49s, then "Claude account switched: vinicios08 (100%) → vinicios12 (0%)".
    Evidence: the bridge keeps one CC process per run (activeQuery) so the token is fixed for the run; switch was checked only in before_agent_start (once per prompt). gentle-agents subagents are separate `pi --mode rpc` processes loading this extension. Session logs show the failure text "Claude quota exceeded — rate limit (five_hour) — resets ...: You've hit your session limit"; Pi 1.3.0 never retries "quota exceeded" (non-retryable list wins), so the run stopped. message_end may replace the message in place before Pi's retry decision; retry is on by default (3 attempts, 2s base). Reworded text "Claude service temporarily unavailable on account ..." matches Pi's retryable pattern.
L12: gentle-ai-verify: S6 PASS (attribution defect), S7 PASS. Fixed: runAccount follows the active account after any other bridge error (a retry spawns a new CLI); no rewrite when Pi's retry budget (settings retry.enabled/maxRetries, failed responses since the last good one) is spent; notice no longer carries the original text (Pi also refuses "billing"); "You're out of extra usage" and curly apostrophes recognised; rename keeps runAccount; PI_CLAUDE_ACCOUNTS_EXTERNAL_TOKEN keeps a subagent from taking the parent's account token for the login account. Not detectable: the bridge discarding a parked query after /compact under a mid-run switch.
