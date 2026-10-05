/**
 * Match result from secret scanning.
 */
export interface SecretMatch {
  patternId: string;
  secretType: string;
  match: string;
  start: number;
  end: number;
  confidence: "high" | "medium" | "low";
  entropy?: number;
}

/**
 * Scanner rule definition.
 */
export interface ScannerRule {
  id: string;
  name: string;
  secretType: string;
  regex: RegExp;
  minEntropy?: number;
  /** Shortest captured value the rule redacts (default 6). Structural credential slots use less. */
  minLength?: number;
  confidence: "high" | "medium" | "low";
}

/**
 * Computes the Shannon entropy of a string (in bits per symbol).
 */
export function calculateShannonEntropy(str: string): number {
  if (!str || str.length === 0) {
    return 0;
  }

  const charCounts: Record<string, number> = {};
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    charCounts[ch] = (charCounts[ch] ?? 0) + 1;
  }

  let entropy = 0;
  const len = str.length;
  for (const count of Object.values(charCounts)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/** Longest run between path separators a path-shaped value may have (a file or directory name). */
const MAX_PATH_RUN_LENGTH = 12;

/**
 * Whether a high-entropy candidate is an ordinary file path (`backups/inventory-2025-06-01.sql`,
 * `D:\backups\inventory-2025-06-01.sql`) rather than a key. Standard base64 has `/` but none of `.`,
 * `-`, `_` and never `\`; URL-safe base64 has no `/`; a random key has long runs between separators;
 * URL userinfo, `key=value` pairs and base64 padding carry `@`, `:`, `=` or `+`. A leading drive
 * (`C:`), `\\?\` long-path prefix or home reference (`$env:USERPROFILE`, `${env:X}`, `%X%`) is a
 * path's own colon. Named-secret rules still scan every value. `requireNameMark` false drops the
 * `.`/`-`/`_` requirement, for a candidate already known not to be base64.
 */
function isPathShaped(candidate: string, requireNameMark = true): boolean {
  const path = candidate.replace(
    /^(?:\$env:[A-Za-z_]\w*|\$\{env:[A-Za-z_]\w*\}|%[A-Za-z_]\w*%|(?:(?:\\\\|\\){2}[?.](?:\\\\|\\))?[A-Za-z]:)(?=[\\/])/i,
    "",
  );
  return (
    /[/\\]/.test(path) &&
    (!requireNameMark || /[._-]/.test(path)) &&
    !/[@:=+]/.test(path) &&
    path.split(/[/\\._-]/).every((run) => run.length <= MAX_PATH_RUN_LENGTH)
  );
}

/** A variable name that marks its value a credential (`DB_PASS`, `GH_TOKEN`, `apiKey`). */
const SECRET_NAME =
  "[A-Za-z0-9_]*(?:PASS|PASSWD|PASSWORD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)";

/** A quoted PowerShell string: `'...'` (`''` escapes a quote) or `"..."` (backtick escapes). */
const PS_QUOTED = String.raw`'((?:[^'\r\n]|''){1,1024})'|"((?:[^"\r\n${"`"}]|${"`"}.|""){1,1024})"`;
/** A PowerShell here-string, `@'` or `@"` through a closing `'@` or `"@` at the start of a line. */
const PS_HERE_STRING = String.raw`@'\r?\n([\s\S]*?)\r?\n'@|@"\r?\n([\s\S]*?)\r?\n"@`;
/** A PowerShell value: a here-string, a quoted string, or one bare word. */
const PS_VALUE = `${PS_HERE_STRING}|${PS_QUOTED}|([^\\s'"${"`"};|&(){}]+)`;
/** A cmd.exe value: a double-quoted string or one bare word. */
const CMD_VALUE = String.raw`"([^"\r\n]*)"|([^\s"&|<>]+)`;

/** Windows PowerShell and cmd.exe spellings of a secret handed to a variable, command or parameter. */
const WINDOWS_SECRET_RULES: ScannerRule[] = [
  {
    id: "powershell_secret_assignment",
    name: "PowerShell Assignment to a Secret-Named Variable",
    secretType: "CREDENTIAL",
    // $env:GH_TOKEN = 'a b', ${env:DB_PASSWORD}="v", $apiKey = @'<lines>'@: the whole string value.
    regex: new RegExp(
      `(?:\\$(?:(?:env|global|script|local|private|using):)?${SECRET_NAME}|\\$\\{(?:(?:env|global|script|local|private):)?${SECRET_NAME}\\})\\s*=\\s*(?:${PS_VALUE})`,
      "gi",
    ),
    confidence: "medium",
  },
  {
    id: "powershell_env_item",
    name: "Secret Written to the PowerShell Env: Drive",
    secretType: "CREDENTIAL",
    // Set-Item Env:GH_TOKEN 'v', Set-Item -Path Env:\GH_TOKEN -Value v, New-Item Env: -Name X_TOKEN -Value v.
    regex: new RegExp(
      `\\b(?:Set-Item|New-Item|Set-Content|si|ni)\\b(?=[^\\n;|]*\\benv:\\\\?(?:["']?\\s+-Name\\s+["']?)?${SECRET_NAME}\\b)[^\\n;|]*?(?:\\s-Value\\s+|env:\\\\?${SECRET_NAME}["']?\\s+(?!-))(?:${PS_VALUE})`,
      "gi",
    ),
    confidence: "medium",
  },
  {
    id: "dotnet_set_environment_variable",
    name: "Secret Passed to Environment.SetEnvironmentVariable",
    secretType: "CREDENTIAL",
    // [Environment]::SetEnvironmentVariable('GH_TOKEN', 'v', 'User').
    regex: new RegExp(
      `\\[(?:System\\.)?Environment\\]::SetEnvironmentVariable\\(\\s*["']${SECRET_NAME}["']\\s*,\\s*(?:${PS_VALUE})`,
      "gi",
    ),
    confidence: "medium",
  },
  {
    id: "powershell_secure_string",
    name: "Plain Text Converted to a SecureString",
    secretType: "CREDENTIAL",
    // ConvertTo-SecureString 'v' -AsPlainText -Force, ConvertTo-SecureString -AsPlainText -String v.
    regex: new RegExp(
      `\\bConvertTo-SecureString(?=[^\\n;|]*-AsPlainText)(?:\\s+-(?:AsPlainText|Force)\\b)*(?:\\s+-String)?\\s+(?:${PS_VALUE})`,
      "gi",
    ),
    confidence: "high",
  },
  {
    id: "powershell_piped_secret",
    name: "String Piped Into a Password Reader",
    secretType: "CREDENTIAL",
    // 'v' | ConvertTo-SecureString -AsPlainText, @'<lines>'@ | docker login --password-stdin.
    regex: new RegExp(
      `(?:${PS_HERE_STRING}|${PS_QUOTED})\\s*\\|\\s*(?:ConvertTo-SecureString\\b(?=[^\\n;|]*-AsPlainText)|[^\\n|;]*?--password-stdin\\b)`,
      "gi",
    ),
    confidence: "high",
  },
  {
    id: "powershell_secret_parameter",
    name: "Secret Passed to a PowerShell Parameter",
    secretType: "CREDENTIAL",
    // Publish-Module -NuGetApiKey v, Connect-X -Password 'a b', -Token:v. Single dash only.
    regex: new RegExp(
      `(?<![\\w-])-(?:Password|Passwd|Token|Secret|ApiKey|NuGetApiKey|AccessToken|AuthToken|ClientSecret|PersonalAccessToken)(?:\\s+|:)(?!-)(?:${PS_VALUE})`,
      "gi",
    ),
    confidence: "medium",
  },
  {
    id: "cmd_set_secret",
    name: "cmd.exe set of a Secret-Named Variable",
    secretType: "CREDENTIAL",
    // set GH_TOKEN=a b (the rest of the command), set "GH_TOKEN=a b".
    regex: new RegExp(
      `\\bset\\s+"${SECRET_NAME}=([^"\\r\\n]+)"|\\bset\\s+${SECRET_NAME}=((?:\\^.|[^\\s&|^<>"])(?:(?:\\^.|[^\\r\\n&|^<>])*(?:\\^.|[^\\s&|^<>]))?)`,
      "gi",
    ),
    confidence: "medium",
  },
  {
    id: "cmd_setx_secret",
    name: "setx of a Secret-Named Variable",
    secretType: "CREDENTIAL",
    // setx GH_TOKEN v, setx /M GH_TOKEN "a b".
    regex: new RegExp(`\\bsetx(?:\\s+/m)?\\s+["']?${SECRET_NAME}["']?\\s+(?:${CMD_VALUE})`, "gi"),
    confidence: "medium",
  },
  {
    id: "cmd_password_switch",
    name: "Password Switch of setx or schtasks",
    secretType: "CREDENTIAL",
    // setx /s host /u user /p V, schtasks /create ... /ru user /rp V.
    regex: new RegExp(`\\b(?:setx|schtasks)\\b[^\\r\\n&|]*?\\s/r?p\\s+(?:${CMD_VALUE})`, "gi"),
    confidence: "medium",
  },
];

/** Shortest standalone token the high-entropy scan considers (and the shortest URL slot it rescans). */
const MIN_TOKEN_LENGTH = 20;
const URL_SHAPE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#]+/;

/**
 * The parts of a URL-shaped token that can carry a secret, with their offsets in the token: the userinfo,
 * each query-string value and the fragment. Null when the token is not a URL. The scheme, host and path
 * are never secret slots, so a percent-encoded path (`/values/Pending%20Invoices%21A1%3AZ200`) is not
 * mistaken for a random key.
 */
function urlSecretSlots(token: string): Array<{ text: string; offset: number }> | null {
  const head = URL_SHAPE.exec(token);
  if (!head) return null;
  const slots: Array<{ text: string; offset: number }> = [];
  const schemeEnd = token.indexOf("://") + 3;
  const authority = head[0].slice(schemeEnd);
  const at = authority.lastIndexOf("@");
  if (at > 0) slots.push({ text: authority.slice(0, at), offset: schemeEnd });
  const hash = token.indexOf("#", head[0].length);
  const fragmentStart = hash === -1 ? token.length : hash;
  const question = token.indexOf("?", head[0].length);
  if (question !== -1 && question < fragmentStart) {
    let pairStart = question + 1;
    for (const pair of token.slice(pairStart, fragmentStart).split("&")) {
      const equals = pair.indexOf("=");
      // A pair with a key carries its secret in the value; a bare one is the value.
      const valueStart = pairStart + (equals === -1 ? 0 : equals + 1);
      slots.push({ text: token.slice(valueStart, pairStart + pair.length), offset: valueStart });
      pairStart += pair.length + 1;
    }
  }
  if (hash !== -1) slots.push({ text: token.slice(hash + 1), offset: hash + 1 });
  return slots;
}

export const DEFAULT_SCANNER_RULES: ScannerRule[] = [
  {
    id: "openai_api_key",
    name: "OpenAI API Key",
    secretType: "OPENAI_API_KEY",
    regex: /\bsk-(?!ant-)(?:proj-|admin-|none-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
    confidence: "high",
  },
  {
    id: "anthropic_api_key",
    name: "Anthropic API Key",
    secretType: "ANTHROPIC_API_KEY",
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    confidence: "high",
  },
  {
    id: "github_token",
    name: "GitHub Personal Access Token",
    secretType: "GITHUB_TOKEN",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    confidence: "high",
  },
  {
    id: "aws_access_key",
    name: "AWS Access Key ID",
    secretType: "AWS_ACCESS_KEY_ID",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    confidence: "high",
  },
  {
    id: "aws_secret_key",
    name: "AWS Secret Access Key",
    secretType: "AWS_SECRET_KEY",
    regex:
      /(?:aws_secret_access_key|aws_secret_key|secret_key)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
    confidence: "high",
  },
  {
    id: "jwt_token",
    name: "JSON Web Token (JWT)",
    secretType: "JWT",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    confidence: "high",
  },
  {
    id: "private_key",
    name: "PEM Private Key",
    secretType: "PRIVATE_KEY",
    regex:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
    confidence: "high",
  },
  {
    id: "bearer_token",
    name: "Bearer Token",
    secretType: "BEARER_TOKEN",
    regex: /\bBearer\s+([A-Za-z0-9_\-\.]{24,})\b/gi,
    confidence: "medium",
  },
  {
    id: "generic_credential",
    name: "Generic Password or Credential Assignment",
    secretType: "CREDENTIAL",
    regex:
      /(?:password|passwd|api_key|apikey|auth_token|client_secret|private_token)["']?\s*[:=]\s*["']?([^"'\s\n\r]{8,})["']?/gi,
    confidence: "medium",
  },
  {
    id: "cli_secret_flag",
    name: "Secret Passed After a Long Command-Line Flag",
    secretType: "CREDENTIAL",
    regex:
      /--(?:password|passwd|pass|token|secret|api-?key|access-token|auth-token|client-secret)(?:\s+|=)["']?([^"'\s-][^"'\s]{5,})["']?/gi,
    confidence: "medium",
  },
  {
    id: "secret_named_assignment",
    name: "Assignment to a Secret-Named Variable",
    secretType: "CREDENTIAL",
    // DB_PASS='v', ERP_PASSWORD=v, GH_TOKEN=v, access_token=v: the variable name marks the value.
    regex:
      /\b[A-Za-z0-9_]*(?:PASS|PASSWD|PASSWORD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)\s*=\s*["']?([^"'\s;&|]{6,})["']?/gi,
    confidence: "medium",
  },
  ...WINDOWS_SECRET_RULES,
  {
    id: "cli_password_argument",
    name: "Password Argument of a Known Client",
    secretType: "CREDENTIAL",
    // sshpass -p V, docker login -p V, redis-cli -a V, and the attached mysql-family -pV form.
    regex:
      /(?:\bsshpass\s+-p\s*|\bdocker\s+login\b[^\n|;&]*?\s-p\s+|\bredis-cli\b[^\n|;&]*?\s-a\s+|\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]*?\s-p)["']?([^"'\s]{6,})["']?/g,
    confidence: "medium",
  },
  {
    id: "slack_token",
    name: "Slack API Token",
    secretType: "SLACK_TOKEN",
    regex: /\bxox[baprs]-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}\b/g,
    confidence: "high",
  },
  {
    id: "google_api_key",
    name: "Google API Key",
    secretType: "GOOGLE_API_KEY",
    regex: /\bAIza[0-9A-Za-z-_]{35}\b/g,
    confidence: "high",
  },
  {
    id: "url_credentials",
    name: "Password in URL Userinfo",
    secretType: "URL_CREDENTIAL",
    // postgres://app:pw@db, redis://:pw@cache, https://user:pat@git.example: the password slot.
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]*:([^\s@"'`/\\]+)@/gi,
    minLength: 1,
    confidence: "high",
  },
  {
    id: "authorization_header",
    name: "HTTP Authorization Credentials",
    secretType: "AUTHORIZATION",
    regex:
      /\b(?:Proxy-)?Authorization\s*:\s*(?:(?:Basic|Bearer|Token|Digest|Negotiate|NTLM|ApiKey|Key)\s+)?([^\s"'`,;\\]+)/gi,
    minLength: 3,
    confidence: "high",
  },
  {
    id: "secret_header",
    name: "Secret-Named HTTP Header",
    secretType: "HEADER_CREDENTIAL",
    // X-Api-Key, DD-API-KEY, X-Auth-Token, Private-Token, X-Secret: a hyphenated header name with a
    // key/token/secret/auth segment. `Author:` or YAML `key:` lack that shape and stay intact.
    regex:
      /(?<![A-Za-z0-9_-])(?:[A-Za-z0-9]+-)+(?:[A-Za-z0-9]*(?:key|token|secret|auth|password)[A-Za-z0-9]*)(?:-[A-Za-z0-9]+)*\s*:\s*(?:(?:Basic|Bearer|Token)\s+)?([^\s"'`,;\\]+)|(?<![A-Za-z0-9_-])(?:[A-Za-z0-9]*(?:key|token|secret|auth|password)[A-Za-z0-9]*)(?:-[A-Za-z0-9]+)+\s*:\s*(?:(?:Basic|Bearer|Token)\s+)?([^\s"'`,;\\]+)/gi,
    minLength: 3,
    confidence: "high",
  },
  {
    id: "http_client_user",
    name: "Credentials Passed to an HTTP Client",
    secretType: "CREDENTIAL",
    // curl -u user:pw, curl -uuser:pw, curl --user=user:pw, wget --user user:pw, http -a user:pw.
    regex:
      /\b(?:curl|wget|https?|httpie|xh)\b[^\n|;&]*?\s(?:-u\s*|--user(?:\s+|=)|-a\s+|--auth(?:\s+|=))["']?[^\s"':]*:([^\s"'`\\]+)/g,
    minLength: 1,
    confidence: "high",
  },
  {
    id: "netrc_password",
    name: "Password in a .netrc Entry",
    secretType: "CREDENTIAL",
    // `machine h login u password V` on one line, or a `password V` line of a multi-line entry.
    regex:
      /\b(?:machine\s+\S+|default)\s+(?:login\s+\S+\s+)?password\s+([^\s"'`\\]+)|^[ \t]*password[ \t]+([^\s"'`\\]+)[ \t]*$/gm,
    minLength: 1,
    confidence: "high",
  },
  {
    id: "cookie_header",
    name: "HTTP Cookie Values",
    secretType: "COOKIE",
    regex: /\b(?:Set-)?Cookie\s*:\s*([^\n"'`\\]+)/gi,
    minLength: 3,
    confidence: "high",
  },
  {
    id: "http_client_password_flag",
    name: "Password Flag of an HTTP Client",
    secretType: "CREDENTIAL",
    regex: /--(?:http-|ftp-|proxy-)password(?:\s+|=)["']?([^"'\s]+)/g,
    minLength: 1,
    confidence: "high",
  },
];

/** A placeholder an earlier redaction step wrote, with its type and keyed tag. */
const PLACEHOLDER = /\[REDACTED_[A-Z_]+:[^\]\s]*\]/g;

/** Context words announcing that the next value on the line is a credential. */
const SECRET_CONTEXT =
  /(?:key|token|secret|passw(?:or)?d|pwd|auth|credential|bearer|session|cookie|signature)[^\n]{0,24}$/i;

/** Git subcommands whose hex arguments and outputs are object names, not secrets. */
const GIT_OBJECT_CONTEXT =
  /\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*(?:checkout|switch|show|log|revert|cherry-pick|reset|rebase|diff|merge|merge-base|rev-parse|rev-list|branch|tag|bisect|blame|cat-file|ls-tree|describe|fetch|push|commit|reflog|format-patch|am|apply|notes|worktree|submodule|stash|restore|grep|shortlog|name-rev|for-each-ref|update-ref|verify-commit)\b/;

/** Checksum tools: their arguments and the checksum lines they read or print are content hashes. */
const CHECKSUM_TOOL_CONTEXT =
  /\b(?:sha(?:1|224|256|384|512)sum|shasum|md5sum|md5|b2sum|b3sum|cksum|openssl\s+dgst|certutil\s+-hashfile)\b/;

/**
 * Labels that name the following hex value a digest or revision. A label may end a longer name
 * (`commit_sha=`, `HEAD_SHA=`, `--match-head-commit`): only a letter or digit right before it
 * makes it part of another word.
 */
const HASH_LABEL_CONTEXT =
  /(?:(?<![A-Za-z0-9])(?:sha(?:1|224|256|384|512)?|md5|blake2b?|blake3|digest|checksum|hash|integrity|commit|revision|rev|oid|object|tree|parent|etag|Merge)\b["']?\s*[:=@-]?\s*["']?|@sha256:|\bsha256:)$/i;
/** The same labels ending a camelCase name (`headSha`, `headRefOid`), as JSON keys spell them. */
const CAMEL_HASH_LABEL_CONTEXT =
  /[a-z0-9](?:Sha|Commit|Oid|Rev|Revision|Digest|Hash|Checksum)["']?\s*[:=]\s*["']?$/;

/** A git revision: an object name or a ref (`HEAD`, `origin/main`, `v1.2.0`) with `~n`/`^n` steps. */
const GIT_REVISION = String.raw`(?:[0-9a-f]{7,40}|[0-9A-F]{7,40}|[A-Za-z][\w.-]*(?:/[\w.-]+)*)(?:[~^][0-9]*)*`;
/** A file at a revision (`<rev>:<path>`, the path holding a `.` or `/`) or a range (`<rev>..<rev>`). */
const GIT_REVISION_ARGUMENT = new RegExp(
  String.raw`^(?:${GIT_REVISION}:(?=[\w./-]*[./])[\w./-]+|${GIT_REVISION}\.{2,3}${GIT_REVISION})$`,
);
/** Longest candidate tested as a revision argument, bounding the regex's backtracking. */
const MAX_GIT_REVISION_ARGUMENT_LENGTH = 256;

/** Lengths of the common hex digests (md5, sha1, sha224, sha256, sha384, sha512). */
const DIGEST_HEX_LENGTHS = new Set([32, 40, 56, 64, 96, 128]);

function lineAround(text: string, start: number, end: number): { before: string; line: string } {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const newline = text.indexOf("\n", end);
  const lineEnd = newline === -1 ? text.length : newline;
  return { before: text.slice(lineStart, start), line: text.slice(lineStart, lineEnd) };
}

/**
 * Whether a hex run is a git object name or content digest in its ordinary, non-secret setting:
 * a git command on the line, `commit <sha>` log output, a checksum tool, a `sha256:`-style label,
 * or a `<digest>  <file>` checksum-list line. A secret label right before the value wins.
 */
function isHashContext(text: string, start: number, end: number): boolean {
  const { before, line } = lineAround(text, start, end);
  if (SECRET_CONTEXT.test(before.slice(-32))) return false;
  if (HASH_LABEL_CONTEXT.test(before) || CAMEL_HASH_LABEL_CONTEXT.test(before)) return true;
  if (GIT_OBJECT_CONTEXT.test(line) || CHECKSUM_TOOL_CONTEXT.test(line)) return true;
  const length = end - start;
  // `<digest>  <file>` / `<digest> *<file>` rows of sha256sum output or SHA256SUMS files.
  if (
    DIGEST_HEX_LENGTHS.has(length) &&
    before.trim() === "" &&
    /^ (?: |\*)\S/.test(text.slice(end, end + 3))
  ) {
    return true;
  }
  // git log --oneline / raw output rows led by an abbreviated or full object name.
  return length === 40 && /^\s*$/.test(before) && /^\s+\S/.test(text.slice(end, end + 2));
}

/**
 * Whether a high-entropy token is a git revision argument (`HEAD:src/a.ts`, `846069b0:notes.json`,
 * `v1.2.0..origin/main`) on a git command line: an object name and a path or range, not a key.
 * A secret label right before it wins.
 */
function isGitRevisionArgument(
  text: string,
  candidate: string,
  start: number,
  end: number,
): boolean {
  if (
    candidate.length > MAX_GIT_REVISION_ARGUMENT_LENGTH ||
    !GIT_REVISION_ARGUMENT.test(candidate)
  ) {
    return false;
  }
  const { before, line } = lineAround(text, start, end);
  return GIT_OBJECT_CONTEXT.test(line) && !SECRET_CONTEXT.test(before.slice(-32));
}

/**
 * Shannon entropy normalized by the most a string of this length over this alphabet can carry,
 * so hex (4 bits max) and short base62 keys are scored on the same 0-1 scale as base64.
 */
export function normalizedEntropy(str: string, alphabetSize: number): number {
  const ceiling = Math.log2(Math.min(alphabetSize, str.length));
  return ceiling > 0 ? calculateShannonEntropy(str) / ceiling : 0;
}

/** A 32+ hex run with both digits and letters, bounded by non-alphanumerics. */
const HEX_RUN = /(?<![A-Za-z0-9])(?:[0-9a-f]{32,}|[0-9A-F]{32,})(?![A-Za-z0-9])/g;
const UUID_RUN =
  /(?<![A-Za-z0-9-])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![A-Za-z0-9-])/g;
/** A bare base62 run (no path, dot, dash or underscore neighbours) of key length. */
const BASE62_RUN = /(?<![A-Za-z0-9_+/.\\-])[A-Za-z0-9]{16,64}(?![A-Za-z0-9_+/.\\-])/g;
/** Minimum alphabet-normalized entropy of a random-looking hex or base62 run. */
const MIN_NORMALIZED_ENTROPY = 0.85;
/**
 * Minimum share of adjacent base62 characters that change class (upper/lower/digit). Random keys
 * average about 0.62; camelCase identifiers (`base64ToUint8Array` 0.47, `HTMLInputElement2` 0.25)
 * stay below. About nine in ten random 16-35 character keys clear it.
 */
const MIN_BASE62_CLASS_SWITCH_RATE = 0.5;

/**
 * Options for configuring ContentScanner.
 */
export interface ContentScannerOptions {
  rules?: ScannerRule[];
  scanEntropy?: boolean;
  entropyThreshold?: number;
  minHighEntropyLength?: number;
}

/**
 * Scanner for identifying credentials, API tokens, and high-entropy strings in text content.
 */
export class ContentScanner {
  private readonly rules: ScannerRule[];
  private readonly scanEntropy: boolean;
  private readonly entropyThreshold: number;
  private readonly minHighEntropyLength: number;

  constructor(options: ContentScannerOptions = {}) {
    this.rules = options.rules ?? [...DEFAULT_SCANNER_RULES];
    this.scanEntropy = options.scanEntropy ?? true;
    this.entropyThreshold = options.entropyThreshold ?? 4.3;
    this.minHighEntropyLength = options.minHighEntropyLength ?? 24;
  }

  /**
   * Adds a custom rule to the scanner.
   */
  addRule(rule: ScannerRule): void {
    this.rules.push(rule);
  }

  /**
   * Scans a text string and returns all matched secrets sorted by starting offset.
   */
  scan(text: string): SecretMatch[] {
    if (!text) {
      return [];
    }

    const matches: SecretMatch[] = [];

    // 1. Run regex-based rules
    for (const rule of this.rules) {
      // `d` records each group's offsets, so a value is located exactly wherever the rule puts it.
      const flags = rule.regex.flags.includes("d") ? rule.regex.flags : `${rule.regex.flags}d`;
      const regex = new RegExp(rule.regex.source, flags);
      const minLength = rule.minLength ?? 6;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        // If there's a capture group (e.g. key value in password: "xxx"), use the first defined one
        const groupIndex = match.findIndex((group, index) => index > 0 && group !== undefined);
        const matchedValue = groupIndex > 0 ? match[groupIndex] : match[0];
        // Skip trivial or short captures or already redacted placeholders
        if (
          matchedValue.length < minLength ||
          matchedValue.startsWith("[REDACTED") ||
          matchedValue.includes("[REDACTED_")
        ) {
          continue;
        }

        const matchStart =
          groupIndex > 0
            ? (match.indices?.[groupIndex]?.[0] ?? match.index + match[0].lastIndexOf(matchedValue))
            : match.index;
        const matchEnd = matchStart + matchedValue.length;
        const entropy = calculateShannonEntropy(matchedValue);

        if (rule.minEntropy !== undefined && entropy < rule.minEntropy) {
          continue;
        }

        matches.push({
          patternId: rule.id,
          secretType: rule.secretType,
          match: matchedValue,
          start: matchStart,
          end: matchEnd,
          confidence: rule.confidence,
          entropy,
        });
      }
    }

    // 2. High-entropy standalone word scanner (if enabled)
    if (this.scanEntropy) {
      const covered = (start: number, end: number) =>
        matches.some((m) => start < m.end && end > m.start);
      const push = (patternId: string, candidate: string, start: number, entropy: number) =>
        matches.push({
          patternId,
          secretType: "HIGH_ENTROPY_SECRET",
          match: candidate,
          start,
          end: start + candidate.length,
          confidence: "medium",
          entropy,
        });

      // 2a. Hex keys (Datadog, Algolia, Twilio, HMAC secrets): a hex alphabet caps Shannon entropy
      // at 4 bits, so score against that ceiling. Digests in git/checksum settings stay intact.
      const digests: Array<{ start: number; end: number }> = [];
      for (const hex of text.matchAll(HEX_RUN)) {
        const candidate = hex[0];
        const start = hex.index;
        const end = start + candidate.length;
        if (!/[0-9]/.test(candidate) || !/[a-f]/i.test(candidate) || covered(start, end)) continue;
        const score = normalizedEntropy(candidate, 16);
        if (score < MIN_NORMALIZED_ENTROPY) continue;
        // A digest named by a path or file (`build-<sha>.log`, `/cache/<md5>/x`) is content-addressed,
        // unless a value slot (`key=`, `token:`) or a secret label (`token`, `/hooks/`) precedes it.
        const lineBefore = lineAround(text, start, end).before;
        const pathNeighbour =
          (/[/\\._-]/.test(text[start - 1] ?? "") || /[/\\._-]/.test(text[end] ?? "")) &&
          !/[=:]$/.test(lineBefore) &&
          !SECRET_CONTEXT.test(lineBefore.slice(-32)) &&
          !/hooks?\/$/i.test(lineBefore);
        if (pathNeighbour || isHashContext(text, start, end)) {
          digests.push({ start, end });
          continue;
        }
        push("high_entropy_hex_secret", candidate, start, calculateShannonEntropy(candidate));
      }

      // 2b. UUIDs are ordinary identifiers unless a secret label (api key, token) introduces them.
      for (const uuid of text.matchAll(UUID_RUN)) {
        const candidate = uuid[0];
        const start = uuid.index;
        const end = start + candidate.length;
        if (covered(start, end)) continue;
        if (!SECRET_CONTEXT.test(lineAround(text, start, end).before.slice(-32))) continue;
        push("uuid_secret", candidate, start, calculateShannonEntropy(candidate));
      }

      // 2c. Short random base62 keys: all three character classes, near-maximal entropy for their
      // length, and frequent class switches. Identifiers keep letters of one case in word runs.
      for (const run of text.matchAll(BASE62_RUN)) {
        const candidate = run[0];
        const start = run.index;
        const end = start + candidate.length;
        if (
          !/[A-Z]/.test(candidate) ||
          !/[a-z]/.test(candidate) ||
          !/[0-9]/.test(candidate) ||
          covered(start, end)
        ) {
          continue;
        }
        if (normalizedEntropy(candidate, 62) < MIN_NORMALIZED_ENTROPY) continue;
        let switches = 0;
        let previousClass = "";
        for (const ch of candidate) {
          const charClass =
            ch >= "a" && ch <= "z" ? "lower" : ch >= "A" && ch <= "Z" ? "upper" : "digit";
          if (previousClass !== "" && charClass !== previousClass) switches++;
          previousClass = charClass;
        }
        if (switches / (candidate.length - 1) < MIN_BASE62_CLASS_SWITCH_RATE) continue;
        push("high_entropy_base62_secret", candidate, start, calculateShannonEntropy(candidate));
      }

      const tokenRegex = /[^\s"'\`\(\)\[\]\{\}<>]{20,}/g;

      /** Flags `candidate` (at `start` in `text`) when it looks like a random key. */
      const considerToken = (candidate: string, start: number): void => {
        const end = start + candidate.length;

        // Skip if already covered by another rule match or already redacted
        if (candidate.startsWith("[REDACTED") || candidate.includes("[REDACTED_")) {
          return;
        }
        // A URL is not a key: its scheme, host and path (percent-encoded or not) are locators. Only
        // the slots that can carry a secret are scanned, each on its own.
        const slots = urlSecretSlots(candidate);
        if (slots) {
          for (const slot of slots) {
            if (slot.text.length >= MIN_TOKEN_LENGTH) considerToken(slot.text, start + slot.offset);
          }
          return;
        }
        if (
          covered(start, end) ||
          isPathShaped(candidate) ||
          isGitRevisionArgument(text, candidate, start, end)
        ) {
          return;
        }
        // `alpine@sha256:<digest>`: once the exempt digest is set aside, too little is left to be a key.
        const inside = digests.filter((digest) => digest.start >= start && digest.end <= end);
        const digestChars = inside.reduce((sum, digest) => sum + digest.end - digest.start, 0);
        if (digestChars > 0 && candidate.length - digestChars < 20) {
          return;
        }
        // `repos/acme/app/commits/<sha>`: with the exempt digest set aside, a path. Random base64
        // never holds a 32+ character run of hex, so no `.`, `-` or `_` is needed to tell them apart.
        if (inside.length > 0) {
          let rest = candidate;
          for (const digest of [...inside].sort((a, b) => b.start - a.start)) {
            rest = `${rest.slice(0, digest.start - start)}0${rest.slice(digest.end - start)}`;
          }
          if (isPathShaped(rest, false)) return;
        }

        // Must have character diversity (mixed case or letters + digits or special symbols)
        const hasUpper = /[A-Z]/.test(candidate);
        const hasLower = /[a-z]/.test(candidate);
        const hasDigit = /[0-9]/.test(candidate);
        const hasSpecial = /[^A-Za-z0-9]/.test(candidate);
        const charSetCount =
          (hasUpper ? 1 : 0) + (hasLower ? 1 : 0) + (hasDigit ? 1 : 0) + (hasSpecial ? 1 : 0);

        if (charSetCount >= 2) {
          const entropy = calculateShannonEntropy(candidate);
          if (entropy >= this.entropyThreshold) {
            matches.push({
              patternId: "high_entropy_secret",
              secretType: "HIGH_ENTROPY_SECRET",
              match: candidate,
              start,
              end,
              confidence: entropy >= 4.8 ? "high" : "medium",
              entropy,
            });
          }
        }
      };

      let tokenMatch: RegExpExecArray | null;
      while ((tokenMatch = tokenRegex.exec(text)) !== null) {
        considerToken(tokenMatch[0], tokenMatch.index);
      }
    }

    // A placeholder an earlier redaction step wrote is never rescanned: its tag is keyed random hex,
    // which a pass (the token scan, say, on `REDACTED_SECRET:<tag>`) could otherwise flag and nest.
    const placeholders = [...text.matchAll(PLACEHOLDER)].map((found) => ({
      start: found.index,
      end: found.index + found[0].length,
    }));
    const outsidePlaceholders = matches.filter(
      (m) => !placeholders.some((span) => m.start < span.end && m.end > span.start),
    );

    // Earliest first; of two matches starting together, the longer (a quoted value over its first word).
    outsidePlaceholders.sort((a, b) => a.start - b.start || b.end - a.end);

    // Overlapping matches become one: a later match reaching past the earlier one extends it, so no
    // tail of a longer value (`set GH_TOKEN=a b`, a here-string body) survives the overlap.
    const nonOverlapping: SecretMatch[] = [];
    let previous: SecretMatch | undefined;

    for (const m of outsidePlaceholders) {
      if (previous === undefined || m.start >= previous.end) {
        previous = { ...m };
        nonOverlapping.push(previous);
      } else if (m.end > previous.end) {
        previous.end = m.end;
        previous.match = text.slice(previous.start, m.end);
        previous.entropy = calculateShannonEntropy(previous.match);
      }
    }

    return nonOverlapping;
  }

  /**
   * Fast check if text contains any secrets.
   */
  hasSecrets(text: string): boolean {
    return this.scan(text).length > 0;
  }
}
