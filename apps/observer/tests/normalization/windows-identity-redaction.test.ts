import { describe, expect, it } from "vitest";
import { type RedactionConfig, RedactionEngine } from "../../src/normalization/index.js";
import { assertNoProhibitedRawData } from "../../src/sync/types.js";

const PLACEHOLDER = /\[REDACTED_[A-Z_]+:[0-9a-f]{16}\]/;

const WINDOWS_ENVIRONMENT = {
  USERPROFILE: "C:\\Users\\alice",
  HOMEDRIVE: "C:",
  HOMEPATH: "\\Users\\alice",
  USERNAME: "alice",
  USERDOMAIN: "CONTOSO",
  USERDNSDOMAIN: "corp.contoso.example",
  COMPUTERNAME: "DESKTOP-7Q2M9ZK",
};

/** A Windows session engine: every input is explicit, so the result is the same on any host OS. */
const windowsEngine = (config: RedactionConfig = {}) =>
  new RedactionEngine({
    platform: "win32",
    homeDir: "C:\\Users\\alice",
    environment: WINDOWS_ENVIRONMENT,
    sensitiveEnvVars: [],
    ...config,
  });

/** Redacts `text` and checks every placeholder's recorded original restores it exactly. */
function redactRecoverably(text: string, config: RedactionConfig = {}): string {
  const originals = new Map<string, string>();
  const engine = windowsEngine({
    ...config,
    onRedact: (placeholder, original) => originals.set(placeholder, String(original)),
  });
  const { data } = engine.redact({ command: text });
  const redacted = String(data.command);
  if (!redacted.includes("$HOME")) {
    let restored = redacted;
    for (const [placeholder, original] of originals) {
      restored = restored.replaceAll(placeholder, original);
    }
    expect(restored).toBe(text);
  }
  return redacted;
}

describe("Windows home directories", () => {
  it.each([
    ["backslashes", "type C:\\Users\\alice\\proj\\a.ts", "type $HOME\\proj\\a.ts"],
    ["forward slashes", "code C:/Users/alice/proj", "code $HOME/proj"],
    ["another case and drive spelling", "dir c:\\USERS\\Alice\\proj", "dir $HOME\\proj"],
    [
      "JSON-escaped backslashes",
      '{"cwd":"C:\\\\Users\\\\alice\\\\proj"}',
      '{"cwd":"$HOME\\\\proj"}',
    ],
    ["a \\\\?\\ long path", "\\\\?\\C:\\Users\\alice\\very\\deep", "$HOME\\very\\deep"],
    ["a JSON-escaped long path", "\\\\\\\\?\\\\C:\\\\Users\\\\alice\\\\x", "$HOME\\\\x"],
    ["a Git Bash drive mount", "cd /c/Users/alice/proj", "cd $HOME/proj"],
    ["a WSL drive mount", "ls /mnt/c/Users/alice/proj", "ls $HOME/proj"],
    ["a %HOMEPATH% expansion", "cd \\Users\\alice\\proj", "cd $HOME\\proj"],
    ["the bare home", "echo C:\\Users\\alice", "echo $HOME"],
  ])("aliases the current home spelled with %s", (_label, text, expected) => {
    expect(windowsEngine().redactString(text).redactedText).toBe(expected);
  });

  it("aliases a home outside Users from USERPROFILE and from %HOMEDRIVE%%HOMEPATH%", () => {
    const engine = windowsEngine({
      homeDir: "D:\\Profiles\\alice",
      environment: { USERPROFILE: "D:\\Profiles\\alice", HOMEDRIVE: "H:", HOMEPATH: "\\alice" },
    });
    expect(engine.redactString("cat d:/profiles/ALICE/notes.txt").redactedText).toBe(
      "cat $HOME/notes.txt",
    );
    expect(engine.redactString("ls /mnt/d/Profiles/alice/x").redactedText).toBe("ls $HOME/x");
    expect(engine.redactString("dir H:\\alice\\docs").redactedText).toBe("dir $HOME\\docs");
    // A sibling whose name only starts with the home's name is someone else's directory.
    expect(engine.redactString("dir D:\\Profiles\\alicia\\x").redactedText).toBe(
      "dir D:\\Profiles\\alicia\\x",
    );
  });

  it("aliases a roaming home on a share, with and without the long-path prefix", () => {
    const engine = windowsEngine({
      homeDir: "C:\\Users\\alice",
      environment: { HOMESHARE: "\\\\fs01\\home$", HOMEPATH: "\\alice" },
    });
    expect(engine.redactString("copy \\\\fs01\\home$\\alice\\docs\\a.txt .").redactedText).toBe(
      "copy $HOME\\docs\\a.txt .",
    );
    expect(engine.redactString("dir \\\\?\\UNC\\fs01\\home$\\alice\\docs").redactedText).toBe(
      "dir $HOME\\docs",
    );
  });

  it.each([
    ["another user's home", "type C:\\Users\\bob\\secrets.txt", ["bob"]],
    ["a name with spaces", 'dir "D:\\Users\\Bob Smith\\Documents\\x"', ["Bob", "Smith"]],
    ["a UNC profile share", "dir \\\\fileserver\\c$\\Users\\carol\\x", ["carol", "fileserver"]],
    ["a JSON-escaped path", '{"p":"C:\\\\Users\\\\dave\\\\x"}', ["dave"]],
    ["a legacy profile root", "dir C:\\Documents and Settings\\erin\\x", ["erin"]],
    ["a WSL mount", "cat /mnt/c/Users/frank/.ssh/config", ["frank"]],
    ["a long path", "\\\\?\\C:\\Users\\grace\\x", ["grace"]],
    ["the same name on another drive", "dir E:\\Users\\alice\\x", ["E:\\Users\\alice"]],
  ])("replaces %s with a keyed placeholder", (_label, text, names) => {
    const redacted = redactRecoverably(text);
    expect(redacted).toMatch(/\[REDACTED_USER_HOME:[0-9a-f]{16}\]/);
    for (const name of names) expect(redacted).not.toContain(name);
    expect(() => assertNoProhibitedRawData({ command: redacted })).not.toThrow();
  });

  it.each([
    "dir C:\\Users\\Public\\Documents",
    "dir C:\\Users\\Default\\AppData",
    "dir C:\\Users\\%USERNAME%\\AppData",
    "dir C:\\Users\\$env:USERNAME\\AppData",
    "echo %USERPROFILE%\\.ssh",
    "echo %HOMEDRIVE%%HOMEPATH%\\proj",
    "Get-Content $env:USERPROFILE\\.gitconfig",
    "Get-Content ${env:USERPROFILE}\\.gitconfig",
    "Get-ChildItem C:\\Windows\\System32\\drivers\\etc",
    'Get-ChildItem "C:\\Program Files\\nodejs"',
    '& "C:\\Program Files\\Git\\bin\\bash.exe" -lc "ls"',
    "C:\\ProgramData\\chocolatey\\lib\\ripgrep-14.1.0\\tools\\rg.exe --files",
    ".\\dbtool restore-test D:\\backups\\inventory-2025-06-01.sql",
    "D:\\data\\archive\\2025-06\\inventory-2025-06-01.sql.gz",
    "dir C:\\tmp\\cache\\3f9a1c07b2e84d65a0f1c2d3e4b5a697\\x",
    "copy \\\\buildsrv\\artifacts\\release-2025-06\\app.zip .",
    "ls /Users/someone/proj",
    "https://example.com/api/Users/123",
  ])("keeps an ordinary path or reference intact: %s", (text) => {
    expect(windowsEngine().redactString(text).redactedText).toBe(text);
  });

  it("scrubs Windows homes from a non-Windows session's content too", () => {
    const engine = new RedactionEngine({
      platform: "linux",
      homeDir: "/home/dev",
      environment: {},
      sensitiveEnvVars: [],
    });
    const redacted = engine.redactString("cat /mnt/c/Users/alice/notes.txt").redactedText;
    expect(redacted).toMatch(/^cat \[REDACTED_USER_HOME:[0-9a-f]{16}\]\/notes\.txt$/);
    expect(engine.redactString("ls /Users/alice/proj").redactedText).toBe("ls /Users/alice/proj");
  });
});

describe("OneDrive for Business folders", () => {
  it("replaces the organization in a redirected folder under or outside the home", () => {
    const underHome = windowsEngine().redactString(
      "notepad C:\\Users\\alice\\OneDrive - Contoso Ltd\\Desktop\\notes.txt",
    ).redactedText;
    expect(underHome).toMatch(
      /^notepad \$HOME\\OneDrive - \[REDACTED_ORGANIZATION:[0-9a-f]{16}\]\\Desktop\\notes\.txt$/,
    );
    const outside = redactRecoverably('dir "D:\\OneDrive - Fabrikam\\Documents"');
    expect(outside).not.toContain("Fabrikam");
    expect(windowsEngine().redactString("dir $HOME\\OneDrive\\Desktop").redactedText).toBe(
      "dir $HOME\\OneDrive\\Desktop",
    );
  });
});

describe("Windows session identity values", () => {
  it.each([
    ["USERNAME", "git config user.name alice", "alice", "USERNAME"],
    ["USERNAME in another case", "net user ALICE /domain", "ALICE", "USERNAME"],
    ["USERDOMAIN", "whoami → contoso\\alice", "contoso", "DOMAIN"],
    ["USERDNSDOMAIN", "nltest /dsgetdc:corp.contoso.example", "corp.contoso.example", "DOMAIN"],
    ["COMPUTERNAME", "dir \\\\DESKTOP-7Q2M9ZK\\share", "DESKTOP-7Q2M9ZK", "HOSTNAME"],
  ])("replaces the %s value", (_label, text, value, type) => {
    const redacted = redactRecoverably(text);
    expect(redacted).not.toContain(value);
    expect(redacted).toMatch(new RegExp(`\\[REDACTED_${type}:[0-9a-f]{16}\\]`));
  });

  it("matches whole words only and skips generic account names", () => {
    const engine = windowsEngine({
      environment: { ...WINDOWS_ENVIRONMENT, USERNAME: "admin", COMPUTERNAME: "WORKGROUP" },
      homeDir: "C:\\Users\\admin",
    });
    expect(engine.redactString("run as admin in WORKGROUP").redactedText).toBe(
      "run as admin in WORKGROUP",
    );
    expect(windowsEngine().redactString("malice and alicexyz stay").redactedText).toBe(
      "malice and alicexyz stay",
    );
  });

  it("derives the user name from the home when USERNAME is unset", () => {
    const engine = windowsEngine({ environment: {} });
    expect(engine.redactString("git log --author=alice").redactedText).toMatch(
      /^git log --author=\[REDACTED_USERNAME:[0-9a-f]{16}\]$/,
    );
  });

  it("leaves identity values of a non-Windows session alone", () => {
    const engine = windowsEngine({ platform: "linux", homeDir: "/home/alice" });
    expect(engine.redactString("git config user.name alice").redactedText).toBe(
      "git config user.name alice",
    );
  });

  it.runIf(process.platform === "win32")(
    "scrubs this machine's own user and computer name with the default configuration",
    () => {
      const user = process.env.USERNAME ?? "";
      const computer = process.env.COMPUTERNAME ?? "";
      const redacted = new RedactionEngine({ sensitiveEnvVars: [] }).redactString(
        `dir C:\\Users\\${user}\\proj & ping ${computer}`,
      ).redactedText;
      if (user.length >= 3) expect(redacted.toLowerCase()).not.toContain(user.toLowerCase());
      if (computer.length >= 3) {
        expect(redacted.toLowerCase()).not.toContain(computer.toLowerCase());
      }
    },
  );

  it("scrubs a secret value before an identity value inside it could split it", () => {
    const engine = windowsEngine({
      environment: { ...WINDOWS_ENVIRONMENT, DATABASE_URL: "postgres://alice:pw0rd@db/app" },
      sensitiveEnvVars: ["DATABASE_URL"],
    });
    const redacted = engine.redactString("psql postgres://alice:pw0rd@db/app").redactedText;
    expect(redacted).toMatch(/^psql \[REDACTED_ENV:DATABASE_URL:[0-9a-f]{16}\]$/);
  });
});

describe("Windows environment secrets", () => {
  it("looks configured variables up case-insensitively in a Windows session", () => {
    const text = "curl -H 'X-Token: gh0-value-1234' https://x";
    const environment = { GitHub_Token: "gh0-value-1234" };
    const windows = windowsEngine({
      environment,
      sensitiveEnvVars: ["GITHUB_TOKEN"],
      scanContent: false,
    });
    expect(windows.redactString(text).redactedText).toContain("[REDACTED_ENV:GITHUB_TOKEN:");
    const linux = windowsEngine({
      platform: "linux",
      homeDir: "/home/dev",
      environment,
      sensitiveEnvVars: ["GITHUB_TOKEN"],
      scanContent: false,
    });
    expect(linux.redactString(text).redactedText).toBe(text);
  });

  it("scrubs the known value of a %VAR% or $env:VAR reference and keeps the reference", () => {
    const engine = windowsEngine({
      environment: { FOO_TOKEN: "v4lue-0f-t0ken" },
      sensitiveEnvVars: undefined,
    });
    const redacted = engine.redactString(
      "echo %FOO_TOKEN% & echo $env:FOO_TOKEN\r\nv4lue-0f-t0ken",
    ).redactedText;
    expect(redacted).toMatch(
      /^echo %FOO_TOKEN% & echo \$env:FOO_TOKEN\r\n\[REDACTED_ENV:FOO_TOKEN:[0-9a-f]{16}\]$/,
    );
  });
});

describe("Windows secret assignment forms", () => {
  it.each([
    ["$env: assignment, single quotes", "$env:FOO_TOKEN = 'tok with spaces 123'", "with spaces"],
    ["$env: assignment, double quotes", '$env:FOO_TOKEN="Zx9Kq2Lm7Pv4"', "Zx9Kq2Lm7Pv4"],
    ["${env:} assignment", '${env:DB_PASSWORD} = "p@ss w0rd!"', "w0rd"],
    ["secret-named variable", "$apiKey = 'k3y with space'", "with space"],
    ["Set-Item positional", "Set-Item Env:FOO_TOKEN 'hunter2hunter2'", "hunter2hunter2"],
    ["Set-Item -Path -Value", 'Set-Item -Path Env:\\FOO_TOKEN -Value "s3cr3t v4lue"', "v4lue"],
    [
      "New-Item -Name -Value",
      "New-Item -Path Env: -Name FOO_TOKEN -Value 'n3wItemS3cret'",
      "n3wItemS3cret",
    ],
    [
      "[Environment]::SetEnvironmentVariable",
      "[Environment]::SetEnvironmentVariable('FOO_TOKEN', 'env var s3cret', 'User')",
      "s3cret",
    ],
    [
      "[System.Environment]::SetEnvironmentVariable",
      '[System.Environment]::SetEnvironmentVariable("FOO_TOKEN", "dotn3tS3cret")',
      "dotn3tS3cret",
    ],
    ["cmd set", "set FOO_TOKEN=cmd s3cret value && echo done", "s3cret value"],
    ["cmd set, quoted", 'set "FOO_TOKEN=quoted cmd s3cret" & call x', "cmd s3cret"],
    ["cmd SET, upper case", "SET FOO_PASSWORD=Up3rCase!", "Up3rCase!"],
    ["setx", "setx FOO_TOKEN s3tx-t0ken", "s3tx-t0ken"],
    ["setx /M, quoted", 'setx /M FOO_TOKEN "s3tx machine t0ken"', "machine"],
    ["setx /p", "setx /s host01 /u corp\\ops /p S3tx-Pass TEMP_DIR x", "S3tx-Pass"],
    ["schtasks /rp", "schtasks /create /tn x /tr y /ru ops /rp Sch3dP4ss", "Sch3dP4ss"],
    [
      "here-string to a secret-named variable",
      "$apiKey = @'\nline-one-s3cret\nline-two-s3cret\n'@\nUse-It $apiKey",
      "s3cret",
    ],
    [
      "expandable here-string to $env:",
      '$env:DEPLOY_TOKEN = @"\nh3re-t0ken-value\n"@',
      "h3re-t0ken-value",
    ],
    [
      "ConvertTo-SecureString positional",
      "ConvertTo-SecureString 'P@ssw0rd!2024' -AsPlainText -Force",
      "P@ssw0rd!2024",
    ],
    [
      "ConvertTo-SecureString -String last",
      'ConvertTo-SecureString -AsPlainText -Force -String "an0ther pass"',
      "an0ther",
    ],
    [
      "string piped to ConvertTo-SecureString",
      "'Pipe s3cret!' | ConvertTo-SecureString -AsPlainText -Force",
      "Pipe s3cret!",
    ],
    [
      "here-string piped to --password-stdin",
      "@'\nregistry-t0ken-value\n'@ | docker login ghcr.io -u me --password-stdin",
      "registry-t0ken-value",
    ],
    ["-NuGetApiKey", "Publish-Module -Name X -NuGetApiKey oy2abcdefghijk", "oy2abcdefghijk"],
    ["-Password", "Connect-Thing -Password 'two words!'", "two words"],
    ["-Token:", "Invoke-Api -Token:abc123xyz789", "abc123xyz789"],
  ])("redacts a %s", (_label, text, secret) => {
    const redacted = redactRecoverably(text);
    expect(redacted).not.toContain(secret);
    expect(redacted).toMatch(PLACEHOLDER);
  });

  it("keeps the rest of the command after a cmd set value", () => {
    expect(
      windowsEngine().redactString("set FOO_TOKEN=cmd s3cret value && echo done").redactedText,
    ).toMatch(/^set FOO_TOKEN=\[REDACTED_CREDENTIAL:[0-9a-f]{16}\] && echo done$/);
  });

  it.each([
    ["POSIX export", "export GH_TOKEN=abc123def456", "abc123def456"],
    ["POSIX quoted assignment", "DB_PASS='s3cretpass' ./run", "s3cretpass"],
    ["POSIX long flag", "deploy --token=abcdef123456", "abcdef123456"],
  ])("still redacts a %s", (_label, text, secret) => {
    expect(windowsEngine().redactString(text).redactedText).not.toContain(secret);
  });

  it.each([
    "echo $env:FOO_TOKEN",
    "Write-Host ${env:GH_TOKEN}",
    "echo %FOO_TOKEN%",
    'Set-Item -Path Env:PATH -Value "C:\\tools;$env:PATH"',
    "$env:NODE_ENV = 'production'",
    "set NODE_ENV=production",
    "Get-Help ConvertTo-SecureString",
    "Get-Item Env:FOO_TOKEN",
  ])("keeps a command without a literal secret intact: %s", (text) => {
    expect(windowsEngine().redactString(text).redactedText).toBe(text);
  });
});
