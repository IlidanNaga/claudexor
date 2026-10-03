#!/usr/bin/env node
import { verifyWin32ConptyHelperCustody } from "./lib/win32-conpty-artifact.mjs";

const files = [];
let expectedSha256;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  const value = process.argv[index + 1];
  if (argument === "--file" && value) {
    files.push(value);
    index += 1;
  } else if (argument === "--expected-sha256" && value) {
    expectedSha256 = value;
    index += 1;
  } else {
    throw new Error(
      `usage: verify-win32-conpty-helper.mjs --file PATH [--file PATH...] [--expected-sha256 HEX] (unexpected ${argument ?? "end"})`,
    );
  }
}

const verified = verifyWin32ConptyHelperCustody(files, expectedSha256);
process.stdout.write(
  `Win32 ConPTY helper verified: PE32+ x64 sha256:${verified.sha256} carriers=${verified.files.length}\n`,
);
