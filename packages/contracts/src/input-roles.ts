/**
 * Caller-facing input names.
 *
 * A name says what role the value plays in the recorded job — the long flag it follows, the kind of
 * file a path names (`archive_path`, `checksum_path`), a date, a directory, a folder name that fills
 * one path segment — and never the recorded value itself: the input that held `alpha` is `folder`,
 * not `alpha`. Only fixed vocabulary and the command's own flag names can appear in a name. The
 * value's type (`number`, `text`) is the last resort.
 *
 * The device names an input from the value it recorded; the cloud, which only sees private
 * references, names one from the recorded plan where the plan shows it. Both use this vocabulary.
 */

/** Where one input's value sits in the recorded plan, and what the recording held there. */
export interface InputSite {
  /** The long flag (`--region`) the whole value follows, if any. */
  flag?: string;
  /** The recorded value at the site; read only to classify its role. */
  value?: string;
  /** The whole program token the value is part of, when it is only a span of it. */
  token?: string;
  /** [start, end) of the value inside `token`. */
  span?: { start: number; end: number };
  /** A harness-tool argument name the whole value is passed as. */
  argument?: string;
}

/** A well-formed input name. */
export const INPUT_NAME = /^[a-z][a-z0-9_]{0,39}$/u;

/** Names chosen from the value's type alone, which say nothing about its role. */
export const VALUE_TYPE_INPUT_NAME = /^(text|path|number|value)(_\d+)?$/u;

const EXTENSION_ROLES: ReadonlyArray<[RegExp, string]> = [
  [/\.(sql|dump|pgdump|bak)(\.(gz|bz2|xz|zst))?$/iu, "dump_path"],
  [/\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2?|txz|tar|zip|7z|rar|gz|bz2|xz|zst)$/iu, "archive_path"],
  [/\.(sha(1|224|256|384|512)(sum)?|md5(sum)?|sum|checksum)$/iu, "checksum_path"],
  [/\.(db|sqlite3?)$/iu, "database_path"],
  [/\.(log)$/iu, "log_path"],
  [/\.(json|ya?ml|toml|ini|conf|cfg|env)$/iu, "config_path"],
  [/\.(csv|tsv|parquet|xlsx?)$/iu, "data_path"],
  [/\.(md|txt|rst|html?|pdf)$/iu, "document_path"],
  [/\.(png|jpe?g|gif|svg|webp)$/iu, "image_path"],
];

function snake(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase()
    .slice(0, 32)
    .replace(/_+$/u, "");
}

/** The value fills one whole `/`-separated segment of a path token (`backups/{folder}/…`). */
function fillsPathSegment(site: InputSite): boolean {
  if (site.token === undefined || site.span === undefined || !site.token.includes("/")) {
    return false;
  }
  const before = site.span.start === 0 ? "/" : site.token[site.span.start - 1];
  const after = site.span.end === site.token.length ? "/" : site.token[site.span.end];
  return before === "/" && after === "/";
}

type Role = { name: string; rank: number };

function siteRole(site: InputSite): Role {
  if (site.flag !== undefined) {
    const name = snake(site.flag);
    if (INPUT_NAME.test(name)) return { name, rank: 0 };
  }
  if (site.argument !== undefined) {
    const name = snake(site.argument);
    if (INPUT_NAME.test(name) && name !== "value" && name !== "input") return { name, rank: 1 };
  }
  const value = site.value;
  if (value !== undefined) {
    if (/^\d{4}-\d{2}-\d{2}$|^\d{4}\d{2}\d{2}$/u.test(value)) return { name: "date", rank: 2 };
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:?\d{2}/u.test(value)) return { name: "timestamp", rank: 2 };
    const base = value.replace(/\/+$/u, "").split("/").at(-1) ?? "";
    for (const [pattern, name] of EXTENSION_ROLES) {
      if (pattern.test(base)) return { name, rank: 3 };
    }
    if (value.includes("/")) {
      return /\.[A-Za-z0-9]{1,8}$/u.test(base)
        ? { name: "file_path", rank: 4 }
        : { name: "directory", rank: 4 };
    }
    if (fillsPathSegment(site)) return { name: "folder", rank: 5 };
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}$/u.test(value)) return { name: "file_name", rank: 6 };
    if (/^-?\d+(\.\d+)?$/u.test(value)) return { name: "number", rank: 7 };
  }
  return { name: "text", rank: 8 };
}

/** The role every site of one input agrees best on: the most specific one any site shows. */
export function inputRoleName(sites: readonly InputSite[]): string {
  let best: Role = { name: "text", rank: 9 };
  for (const site of sites) {
    const role = siteRole(site);
    if (role.rank < best.rank) best = role;
  }
  // A folder is recognised from any site where it fills a path segment, even when another site
  // passes it whole (`tar -C data {folder}`).
  if (best.rank > 5 && sites.some(fillsPathSegment)) return "folder";
  return best.name;
}

/** `base`, or `base_2`, `base_3`, … — the first not in `used`, which it is added to. */
export function uniqueInputName(base: string, used: Set<string>): string {
  let name = base;
  for (let suffix = 2; used.has(name); suffix += 1) name = `${base}_${suffix}`;
  used.add(name);
  return name;
}
