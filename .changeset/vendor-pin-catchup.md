---
"@claudexor/harness-claude": patch
"@claudexor/harness-codex": patch
---

Pin the managed harness installer to Claude Code 2.1.281 and Codex 0.156.1, so a fresh managed Codex install can run GPT-6 Sol and GPT-6 Luna, which Codex 0.153.3 neither lists nor runs on a ChatGPT account. The Codex effort snapshot and manifest hints add both models from a live 0.156.1 `model/list` capture (the default stays GPT-6 Astra; older ladders are kept under the snapshot's union rule), and the Claude `--help` effort ladder was re-captured from 2.1.281 unchanged. Stream recordings that need no paid call and no credentials were re-recorded from the pinned binaries; recordings that need a paid live run or a real vendor incident keep the version they were captured from. The Claude known-model hint list keeps its last actual verification stamp (2.1.261) instead of following the pin. An already-installed CLI is not replaced.
