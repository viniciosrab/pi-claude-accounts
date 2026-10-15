# claude-accounts
Pi extension: several Claude Code accounts for claude-bridge, automatic switch at 95% of the 5h window.
Bridge facts: CLI spawned per prompt, inherits process.env; CLAUDE_CODE_OAUTH_TOKEN beats ~/.claude/.credentials.json; rate_limit_event arrives every request.

## Specs
- S1: "Só o limite de 5 horas" — only the five_hour window drives switching.
- S2: "Eu usei 95% Tem 5% restante Você já vai fazer a troca" — switch when active account utilization >= 0.95.
- S3: "A troca é automática Sem pedir conformação nenhuma" + "Pode até Botar um aviso" — no confirmation, notify on switch.
- S4: "Já vai estar cadastrado" — accounts registered via /claude-accounts add|list|remove|use|status, stored 0600.
- S5: "Enquanto eu for usando Se não tiver batido O limite ... Ele vai continuar na conta" — stay on the current account below threshold.

## Tasks
- T1 (S2,S5) pure policy pickAccount + tests — inline — commit: e66b3ed
- T2 (S4) store (0600) + tests — inline — commit: 0a2aef6
- T3 (S1,S3,S4) extension wiring: usage capture, env switch, notify, commands — inline — commit: pending
- T4 docs README — inline — commit: pending

## Log
L1: Vamos criar agora um plugin... extensão aqui para o Pi... várias contas minhas do Claude Code. Quando chegar 95% do limite de 5 horas, automaticamente troca para outra conta... Sem pedir confirmação... Pode até botar um aviso aqui no Pi que foi trocado... uso o CloudBridge... analisar o CloudBridge.
L2: "go" (analysis), "go" (implement; probes confirmed env token wins, event per request, real token works).
