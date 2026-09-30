import { describe, expect, it } from "vitest";
import {
  type ProcessTableReader,
  harnessLoginIdentity,
  inheritedHarnessEnvironment,
} from "../../src/workflow/harness-environment.js";

/** A launcher chain: 30 (the MCP server's parent shell) → 20 (the harness) → 10 (a container init). */
const processes: ProcessTableReader = {
  environment: (pid) =>
    ({
      30: "PATH=/launch/path\0HOME=/root",
      20: [
        "PATH=/image/bin:/usr/bin",
        "PYTHONPATH=/opt/conda/lib:/opt/conda/Mod",
        "FREECAD_LIB=/opt/conda/lib",
        "OPENAI_API_KEY=sk-secret",
        "GITHUB_TOKEN=ghp_secret",
        "CODEX_HOME=/root/.codex",
        "RESIN_PROFILE=/opt/profile.json",
        "NODE_OPTIONS=--inspect",
        "PWD=/somewhere",
      ].join("\0"),
      10: "PYTHONPATH=/init/value\0LANG=C.UTF-8\0MALFORMED",
    })[pid],
  parent: (pid) => ({ 30: 20, 20: 10 })[pid],
};

describe("inheritedHarnessEnvironment", () => {
  it("recovers the image's variables the launched process was not given (an image's PYTHONPATH)", () => {
    expect(
      inheritedHarnessEnvironment({ PATH: "/launch/path", HOME: "/root" }, { pid: 30, processes }),
    ).toEqual({
      PYTHONPATH: "/opt/conda/lib:/opt/conda/Mod",
      FREECAD_LIB: "/opt/conda/lib",
      LANG: "C.UTF-8",
    });
  });

  it("never overrides what the process has, and reads nothing off Linux", () => {
    expect(
      inheritedHarnessEnvironment({ PYTHONPATH: "/mine" }, { pid: 30, processes }).PYTHONPATH,
    ).toBeUndefined();
    expect(inheritedHarnessEnvironment({}, { pid: 30, processes, platform: "darwin" })).toEqual({});
  });

  it("never forwards a credential, whatever it is called or where it sits", () => {
    const env = [
      "PYTHONPATH=/opt/conda/lib",
      "DB_PASSWORD=hunter2",
      "AWS_SECRET_ACCESS_KEY=abc",
      "SSH_AUTH_SOCK=/tmp/agent.1",
      "GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "MY_COOKIE_JAR=/tmp/c",
      "XDG_SESSION_ID=4",
      "DATABASE_URL=postgres://app:pw@db:5432/x",
      "PIP_CACHE=https://user:pw@example.com/simple",
      "INNOCENT_NAME=sk-live-abcdefghijklmnop",
      "AKIA_LOOKING=AKIAABCDEFGHIJKLMNOP",
      "PEM=-----BEGIN PRIVATE KEY-----",
      "CODEX_SANDBOX=1",
      "RESIN_DEVICE=abc",
      "OPENAI_ORG=o",
      "ANTHROPIC_MODEL=m",
      "LD_PRELOAD=/tmp/evil.so",
      "BASH_ENV=/tmp/evil.sh",
      "PROMPT_COMMAND=curl evil",
      "BASH_FUNC_x%%=() { :; }",
      "NODE_OPTIONS=--require /tmp/x.js",
      "FREECAD_LIB=/opt/conda/lib",
    ].join("\0");
    const recovered = inheritedHarnessEnvironment(
      {},
      { pid: 5, processes: { environment: () => env, parent: () => undefined } },
    );
    expect(recovered).toEqual({ PYTHONPATH: "/opt/conda/lib", FREECAD_LIB: "/opt/conda/lib" });
  });
});

describe("harnessLoginIdentity", () => {
  // The MCP server (pid 30) was launched with a private HOME; the harness (20) runs as root.
  const launched: ProcessTableReader = {
    environment: (pid) =>
      ({
        30: "PATH=/launch/path\0HOME=/var/lib/resin-home\0USER=resin",
        20: "PATH=/image/bin\0HOME=/root\0USER=root\0LOGNAME=root\0PYTHONPATH=/opt/lib",
        10: "HOME=/init/home\0LOGNAME=init",
      })[pid],
    parent: (pid) => ({ 30: 20, 20: 10 })[pid],
  };

  it("reads the user the harness ran its shell as, not the home the server was launched with", () => {
    // The server's own process (30) is not read: its parent, the harness, names the login user.
    expect(harnessLoginIdentity({ pid: 20, processes: launched })).toEqual({
      HOME: "/root",
      USER: "root",
      LOGNAME: "root",
    });
  });

  it("takes each variable from the nearest ancestor that has it, and nothing off Linux", () => {
    const partial: ProcessTableReader = {
      environment: (pid) => ({ 20: "USER=root", 10: "HOME=/init/home\0USER=other" })[pid],
      parent: (pid) => ({ 20: 10 })[pid],
    };
    expect(harnessLoginIdentity({ pid: 20, processes: partial })).toEqual({
      USER: "root",
      HOME: "/init/home",
    });
    expect(harnessLoginIdentity({ pid: 20, processes: launched, platform: "darwin" })).toEqual({});
  });
});
