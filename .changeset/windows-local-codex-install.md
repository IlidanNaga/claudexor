---
"@claudexor/core": minor
"@claudexor/cli": minor
---

`claudexor harness install codex --target local` works on Windows, and doctor, login and runs resolve the image it installs.

On Windows an npm global prefix holds only `.cmd`/sh/ps1 shims and no executable image, and Claudexor never spawns a harness through a shell (issue #191). The local target is therefore supported exactly where the pinned package yields a verified package-native image: `@openai/codex` resolves its `@openai/codex-win32-<arch>` platform package and executes `vendor/<triple>/bin/codex.exe`. Core's `runtime-env.ts` becomes the one owner of that layout (`npmGlobalPackagesDir`, `embeddedNpmCli`, `windowsNativeImageDir`, `managedWindowsNativeImageDirs`): the installer runs the embedded `node_modules/npm/bin/npm-cli.js` beside `node.exe`, forwards the Windows process-environment keys, anchors the managed root on the same `HOME` the harness PATH producer reads, and proves the image inside the prefix; the normalized harness PATH carries that image dir on win32 so every local surface resolves the same `codex.exe` by bare name. The receipt fields are unchanged. Claude, OpenCode, Cursor and Antigravity keep a typed `unsupported_platform` refusal on the Windows local target, now naming the exact reason; an unsupported architecture refuses the same way. The Windows CI lane installs the real pinned package on the exact embedded Node with no ambient node/npm and an isolated profile, then checks the receipt, direct and by-name `--version`, the idempotent recheck and `doctor --json` (`scripts/windows-local-install-smoke.mjs`). Linux and macOS behaviour is unchanged.

Invariants: INV-067 (the same scoped env that spawns a run resolves the binary), INV-121/INV-122 (one layout owner reused by proof and PATH), INV-044 (typed refusals, no silent shim). No Bible change.
