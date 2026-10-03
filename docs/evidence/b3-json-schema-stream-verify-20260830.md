# B3 live-verify receipt (2026-08-30, claude CLI 2.1.221, profile claude-proton-claude scoped CLAUDE_CONFIG_DIR, model claude-haiku-4-5-20251001, temp HOME, fresh git repo cwd)

## Probe 1: --json-schema x one-shot -p (readonly --tools Read,Glob,Grep)
Command: claude -p "Reply with answer='ok' and confidence=0.9" --json-schema '{"type":"object","properties":{"answer":{"type":"string"},"confidence":{"type":"number"}},"required":["answer","confidence"],"additionalProperties":false}' --output-format json --tools Read,Glob,Grep
Result: terminal_reason=completed, structured_output={"answer":"ok","confidence":0.9}, result='{"answer":"ok","confidence":0.9}' — PASS.

## Probe 2: --json-schema x stream-json (interactive transport shape)
Command: printf '<user frame>' | claude -p --input-format stream-json --output-format stream-json --verbose --json-schema '<same schema>' --tools Read,Glob,Grep
Result: assistant frame carries tool_use name=StructuredOutput input={"answer":"stream-ok","confidence":0.8} conforming to the schema; terminal result frame is_error:false — PASS.

Conclusion: the outputSchema x interactive refusal (orchestrator.ts:1556-1577, DT2.1-16) guards a combination the CLI now supports on BOTH transports. The refusal can be deleted without transport rerouting; AskUserQuestion is preserved on schema runs. The adapter's interactive path must pass --json-schema and read the structured result from the stream (verify in code during X-4).

## Probe 3 (X-1 receipt): AskUserQuestion in readonly --tools, both transports
One-shot (`-p`, no --permission-prompt-tool), --tools Read,Glob,Grep,WebSearch,WebFetch,AskUserQuestion:
init frame tools n=5 (Ask NOT materialized — the documented harmless no-op).
Interactive (--input-format stream-json --permission-prompt-tool stdio), same --tools:
init frame tools n=6 with AskUserQuestion present, and NOT pre-approved in --allowedTools.

## Probe 4 (X-2 receipt): deny-pattern precedence beside bare allow
`--permission-mode acceptEdits --allowedTools Bash --disallowedTools "Bash(rm:*)"`,
prompt asking to run `rm -f /tmp/x_probe_target`:
result: permission_denials carries the Bash rm command; the target file SURVIVED;
the model reports the permission system blocked the destructive command.
Vendor precedence confirmed: a caller's narrower Bash(...) deny bites beside the
bare Bash pre-approval.

All probes: claude CLI 2.1.221, model claude-haiku-4-5-20251001, scoped
CLAUDE_CONFIG_DIR (isolated credential profile), throwaway HOME, fresh git cwd.
