/**
 * Windows spellings of the user's identity: profile directories (`C:\Users\<name>` with any drive,
 * separator, case, JSON escaping, `\\?\` long-path or UNC prefix, and the `/c/Users/<name>` and
 * `/mnt/c/Users/<name>` forms Git Bash and WSL print), OneDrive for Business folder names, and the
 * `USERNAME`, `USERDOMAIN`, `USERDNSDOMAIN` and `COMPUTERNAME` values of a Windows session.
 *
 * The current user's home becomes `$HOME` (a valid reference in POSIX shells and PowerShell alike);
 * any other user's home becomes one keyed placeholder, so neither name leaves the device.
 */

/** One path separator as Windows content spells it: `\`, a JSON-escaped `\\`, or `/`. */
const SEP = String.raw`(?:\\\\|\\|/)`;
/** A backslash, raw or JSON-escaped. */
const BACKSLASH = String.raw`(?:\\\\|\\)`;
/** The `\\?\` long-path or `\\.\` device prefix. */
const DEVICE = `${BACKSLASH}${BACKSLASH}[?.]${BACKSLASH}`;
/** A character a profile folder name can hold (Windows forbids the rest; brackets end placeholders). */
const NAME_CHAR = String.raw`[^\\/\s"'${"`"}<>|:*?;,=\[\]]`;
/** A profile folder name: up to four space-separated words when a separator follows, else one word. */
const NAME = `(?:${NAME_CHAR}+(?: ${NAME_CHAR}+){1,3}(?=${SEP})|${NAME_CHAR}+)`;
const HOST = "[A-Za-z0-9][A-Za-z0-9._-]*";
const SHARE = String.raw`[^\\/\s"'${"`"}<>|:*?]+`;

/** Where a profile root starts: a long-path, UNC, drive, Git Bash / WSL mount, or drive-less prefix. */
const PROFILE_ROOT = [
  `${DEVICE}(?:UNC${BACKSLASH}(?<lhost>${HOST})${BACKSLASH}(?<lshare>${SHARE})|(?<ldrive>[A-Za-z]):)${SEP}`,
  `${BACKSLASH}${BACKSLASH}(?<host>${HOST})${BACKSLASH}(?<share>${SHARE})${SEP}`,
  `(?<![A-Za-z0-9_])(?<drive>[A-Za-z]):${SEP}`,
  String.raw`(?<![\w.~$-])/(?:mnt/|cygdrive/)?(?<pdrive>[A-Za-z])/`,
  // `%HOMEPATH%` expands to a drive-less `\Users\<name>`.
  String.raw`(?<=^|[\s"'=(,;>|&%])${BACKSLASH}`,
].join("|");

/**
 * A user profile directory under `Users` (or the pre-Vista `Documents and Settings`) on any drive or
 * share, as a Windows program, a JSON transcript, Git Bash or WSL spells it.
 */
const USER_HOME = new RegExp(
  `(?:${PROFILE_ROOT})(?<profiles>Users|Documents and Settings)${SEP}(?<name>${NAME})`,
  "gi",
);

/** Profile folders that belong to no one: shared, template and system profiles. */
const SHARED_PROFILES: ReadonlySet<string> = new Set([
  "public",
  "default",
  "default user",
  "all users",
  "defaultuser0",
  "defaultapppool",
]);

/** A OneDrive for Business folder, `OneDrive - <organization>`: the organization names the employer. */
const ONEDRIVE_ORGANIZATION = new RegExp(
  String.raw`(?<=OneDrive - )(?:[^\\/"'${"`"}\r\n<>|:*?\[\]]{1,64}?(?=${SEP}|["'${"`"}\r\n]|$)|[^\\/\s"'${"`"}<>|:*?\[\]]+)`,
  "g",
);

/** A placeholder an earlier redaction step wrote; identity scrubbing never rewrites inside one. */
const PLACEHOLDER = /\[REDACTED_[A-Z_]+:[^\]\s]*\]/g;

/** Identity values too generic to name anyone; scrubbing them would only garble ordinary text. */
const GENERIC_IDENTITIES: ReadonlySet<string> = new Set([
  "user",
  "users",
  "admin",
  "administrator",
  "guest",
  "owner",
  "default",
  "public",
  "system",
  "test",
  "dev",
  "root",
  "runner",
  "workgroup",
  "localhost",
  "home",
  "local",
]);

/** Session variables whose value identifies the user, the machine or its organization. */
const IDENTITY_VARIABLES: ReadonlyArray<readonly [string, string]> = [
  ["USERNAME", "USERNAME"],
  ["USERDOMAIN", "DOMAIN"],
  ["USERDNSDOMAIN", "DOMAIN"],
  ["COMPUTERNAME", "HOSTNAME"],
];

export interface WindowsIdentityOptions {
  /** The current user's home directory. */
  homeDir?: string;
  /** Environment of the session whose content is scrubbed. */
  environment: Readonly<Record<string, string | undefined>>;
  /** Platform the session ran on; identity values are scrubbed for Windows sessions only. */
  platform: NodeJS.Platform;
}

export interface WindowsIdentityResult {
  text: string;
  patterns: string[];
}

/** Builds a placeholder of `type` for `original`, recording it for local recovery. */
export type PlaceholderFactory = (type: string, original: string) => string;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Looks a variable up the way Windows does: names are case-insensitive. */
export function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  const exact = environment[name];
  if (exact !== undefined || platform !== "win32") return exact;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/** Whether a path is spelled the Windows way: a drive root or a UNC share. */
export function isWindowsPath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(value);
}

/** Canonical, case-folded spelling of a `USER_HOME` match, so every spelling of one home compares equal. */
function userHomeKey(groups: Record<string, string | undefined>): string {
  const profile = `${(groups.profiles ?? "").toLowerCase()}\\${(groups.name ?? "").toLowerCase()}`;
  const drive = groups.ldrive ?? groups.drive ?? groups.pdrive;
  if (drive !== undefined) return `${drive.toLowerCase()}:\\${profile}`;
  const host = groups.lhost ?? groups.host;
  if (host !== undefined) {
    return `\\\\${host.toLowerCase()}\\${(groups.lshare ?? groups.share ?? "").toLowerCase()}\\${profile}`;
  }
  return `\\${profile}`;
}

/**
 * Pattern for one literal home directory in every spelling: any separator, JSON escaping, drive
 * letter case, `\\?\` prefix, and the Git Bash / WSL mount forms of a drive path.
 */
function literalHomePattern(home: string): string | undefined {
  let normalized = home.replaceAll("/", "\\");
  if (/^\\\\\?\\UNC\\/i.test(normalized)) normalized = `\\\\${normalized.slice(8)}`;
  else if (/^\\\\[?.]\\/.test(normalized)) normalized = normalized.slice(4);
  let root: string;
  let rest: string;
  const drive = /^([A-Za-z]):\\/.exec(normalized);
  const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(normalized);
  if (drive) {
    const letter = drive[1] as string;
    root = `(?:(?:${DEVICE})?${letter}:|(?<![\\w.~$-])/(?:mnt/|cygdrive/)?${letter}(?=/))`;
    rest = normalized.slice(2);
  } else if (unc) {
    const host = escapeRegExp(unc[1] as string);
    const share = escapeRegExp(unc[2] as string);
    root = `(?:${DEVICE}UNC${BACKSLASH}|${BACKSLASH}${BACKSLASH})${host}${BACKSLASH}${share}`;
    rest = normalized.slice(unc[0].length);
  } else {
    return undefined;
  }
  const segments = rest.split("\\").filter((segment) => segment.length > 0);
  if (segments.length === 0) return undefined;
  return `${root}${segments.map((segment) => `${SEP}${escapeRegExp(segment)}`).join("")}(?!${NAME_CHAR})`;
}

/**
 * Replaces every match of `pattern` outside existing placeholders. `replace` returns the substitute,
 * or undefined to keep the match.
 */
function replaceOutsidePlaceholders(
  text: string,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => string | undefined,
): string {
  const spans = [...text.matchAll(PLACEHOLDER)].map((found) => ({
    start: found.index,
    end: found.index + found[0].length,
  }));
  let out = "";
  let last = 0;
  const regex = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex++;
      continue;
    }
    const start = match.index;
    const end = start + match[0].length;
    if (spans.some((span) => start < span.end && end > span.start)) continue;
    const substitute = replace(match);
    if (substitute === undefined) continue;
    out += text.slice(last, start) + substitute;
    last = end;
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * Scrubs Windows home directories, OneDrive organizations and session identity values from text.
 */
export class WindowsIdentityScrubber {
  private readonly literalHomes: RegExp | undefined;
  private readonly currentHomeKeys: ReadonlySet<string>;
  private readonly identities: ReadonlyArray<{ pattern: RegExp; type: string; name: string }>;

  constructor(options: WindowsIdentityOptions) {
    const { environment, platform } = options;
    const lookup = (name: string) => environmentValue(environment, name, platform);
    const homeDrive = lookup("HOMEDRIVE");
    const homePath = lookup("HOMEPATH");
    const homeShare = lookup("HOMESHARE");
    const homes = new Set<string>();
    for (const candidate of [
      options.homeDir,
      lookup("USERPROFILE"),
      homeDrive && homePath ? `${homeDrive}${homePath}` : undefined,
      homeShare && homePath ? `${homeShare}${homePath}` : undefined,
    ]) {
      if (candidate && isWindowsPath(candidate)) homes.add(candidate.replace(/[\\/]+$/, ""));
    }

    const literalPatterns = [...homes]
      .map((home) => literalHomePattern(home))
      .filter((pattern): pattern is string => pattern !== undefined)
      .sort((a, b) => b.length - a.length);
    this.literalHomes =
      literalPatterns.length > 0 ? new RegExp(literalPatterns.join("|"), "gi") : undefined;

    const keys = new Set<string>();
    for (const home of [...homes, homePath]) {
      if (!home) continue;
      const found = new RegExp(`^${USER_HOME.source}`, "i").exec(home);
      if (!found?.groups || found[0].length < home.replace(/[\\/]+$/, "").length) continue;
      keys.add(userHomeKey(found.groups));
      // `%HOMEPATH%` spells the same home without its drive.
      keys.add(userHomeKey({ profiles: found.groups.profiles, name: found.groups.name }));
    }
    this.currentHomeKeys = keys;

    const identities: Array<{ value: string; type: string; name: string }> = [];
    if (platform === "win32") {
      const seen = new Set<string>();
      const homeName =
        options.homeDir && isWindowsPath(options.homeDir)
          ? /[\\/](?:Users|Documents and Settings)[\\/]([^\\/]+)[\\/]*$/i.exec(options.homeDir)?.[1]
          : undefined;
      const candidates: Array<[string | undefined, string, string]> = [
        ...IDENTITY_VARIABLES.map(([variable, type]): [string | undefined, string, string] => [
          lookup(variable),
          type,
          variable,
        ]),
        [homeName, "USERNAME", "USERNAME"],
      ];
      for (const [raw, type, name] of candidates) {
        const value = raw?.trim();
        if (!value || value.length < 3 || GENERIC_IDENTITIES.has(value.toLowerCase())) continue;
        if (seen.has(value.toLowerCase())) continue;
        seen.add(value.toLowerCase());
        identities.push({ value, type, name });
      }
    }
    this.identities = identities
      .sort((a, b) => b.value.length - a.value.length)
      .map(({ value, type, name }) => ({
        pattern: new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(value)}(?![A-Za-z0-9_])`, "gi"),
        type,
        name,
      }));
  }

  scrub(text: string, placeholder: PlaceholderFactory): WindowsIdentityResult {
    const patterns = new Set<string>();
    let current = text;

    if (this.literalHomes) {
      current = replaceOutsidePlaceholders(current, this.literalHomes, () => {
        patterns.add("path_alias:$HOME");
        return "$HOME";
      });
    }

    current = replaceOutsidePlaceholders(current, USER_HOME, (match) => {
      const groups = match.groups ?? {};
      const name = (groups.name ?? "").toLowerCase();
      if (SHARED_PROFILES.has(name) || /^[%$~]/.test(name)) return undefined;
      if (this.currentHomeKeys.has(userHomeKey(groups))) {
        patterns.add("path_alias:$HOME");
        return "$HOME";
      }
      patterns.add("windows_user_home");
      return placeholder("USER_HOME", match[0]);
    });

    current = replaceOutsidePlaceholders(current, ONEDRIVE_ORGANIZATION, (match) => {
      patterns.add("onedrive_organization");
      return placeholder("ORGANIZATION", match[0]);
    });

    for (const { pattern, type, name } of this.identities) {
      current = replaceOutsidePlaceholders(current, pattern, (match) => {
        patterns.add(`identity:${name}`);
        return placeholder(type, match[0]);
      });
    }

    return { text: current, patterns: [...patterns] };
  }
}
