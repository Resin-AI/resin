/**
 * The path a recorded `file:` URL names, in the flavour of the machine that recorded it rather than
 * the host decoding it: a drive (`file:///C:/…`) or a remote host (`file://server/share/…`) names a
 * Windows path, anything else a POSIX one. Throws for a URL that names no path.
 *
 * `fileURLToPath` picks the flavour from the host (its `windows` option needs Node 22.1), so a POSIX
 * recording decoded on Windows would throw; this follows its rules for each flavour instead.
 */
export function recordedFileUrlPath(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "file:") throw new TypeError(`not a file URL: ${parsed.protocol}`);
  const { hostname, pathname } = parsed;
  const remote = hostname !== "" && hostname !== "localhost";
  if (!remote && !/^\/[A-Za-z]:(?:\/|$)/u.test(pathname)) {
    if (/%2f/iu.test(pathname)) throw new TypeError("file URL path must not encode '/'");
    return decodeURIComponent(pathname);
  }
  if (/%2f|%5c/iu.test(pathname)) throw new TypeError("file URL path must not encode '\\' or '/'");
  const path = decodeURIComponent(pathname).replaceAll("/", "\\");
  return remote ? `\\\\${hostname}${path}` : path.slice(1);
}
