import { describe, expect, it } from "vitest";
import { isHarnessIntrospectionProgram, referencesHarnessState } from "../src/index.js";

describe("Windows spellings of the home state trees", () => {
  it.each([
    "type C:\\Users\\alice\\.resin\\config.json",
    "type c:/users/alice/.codex/config.toml",
    "Get-Content D:\\Users\\alice\\.claude.json",
    "type C:\\\\Users\\\\alice\\\\.resin\\\\config.json",
    "type \\\\?\\C:\\Users\\alice\\.omp\\agent\\config.yml",
    "dir \\\\fs01\\profiles$\\Users\\alice\\.resin",
    "dir \\Users\\alice\\.resin",
    "dir C:\\Documents and Settings\\alice\\.codex",
    "cat /c/Users/alice/.codex/config.toml",
    "cat /mnt/c/Users/alice/.claude.json",
    "type %USERPROFILE%\\.resin\\config.json",
    "type %HOMEDRIVE%%HOMEPATH%\\.resin\\config.json",
    "Get-Content $env:USERPROFILE\\.claude.json",
    "Get-Content ${env:USERPROFILE}\\.codex\\config.toml",
    "Get-Content $env:HOMEDRIVE$env:HOMEPATH\\.resin\\config.json",
    "Get-Content ${env:HOMEDRIVE}${env:HOMEPATH}\\.omp\\agent",
    "Get-ChildItem $HOME\\.resin",
    "Get-ChildItem ~\\.resin",
    "Get-Content [REDACTED_USER_HOME:0123456789abcdef]\\.codex\\config.toml",
  ])("flags %s", (source) => {
    expect(referencesHarnessState(source)).toBe(true);
    expect(isHarnessIntrospectionProgram(source)).toBe(true);
  });

  it.each([
    "type C:\\Users\\alice\\proj\\.resinrc",
    "type C:\\Users\\alice\\proj\\.resin\\notes.md",
    "type C:\\work\\.resin\\config.json",
    "Get-Content $env:USERPROFILE\\proj\\README.md",
    "dir C:\\Users\\Public\\Documents",
  ])("does not flag %s", (source) => {
    expect(isHarnessIntrospectionProgram(source)).toBe(false);
  });
});
