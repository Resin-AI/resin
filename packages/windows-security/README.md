# @resin/windows-security

Native Windows security primitives for Resin. On native Windows (not WSL) Resin uses this package to:

- serve the daemon's IPC over a named pipe whose every instance carries an owner-only DACL (plus an explicit deny for network logons), rejects remote clients and claims its name with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so another user can neither connect nor squat the name unnoticed;
- let clients check, before sending anything, that the pipe and its server process belong to the current user;
- create and validate owner-only DACLs on the Resin home and its private files, the Windows counterpart of POSIX `0700`/`0600` modes.

Every export can be imported on any OS. Off Windows, `ensureOwnerOnly` is a no-op, `checkOwnerOnly` reports ok and `isWindowsSecurityAvailable()` is `false`; the other functions throw a clear error.

## API

| Export | Purpose |
| --- | --- |
| `isWindowsSecurityAvailable()` | `true` on Windows when the native helper loads. |
| `currentUserSid()` | String SID of the process user. |
| `ensureOwnerOnly(path, { directory })` | Owner = current user, protected DACL with one full-control ACE for that user (inheritable for directories and propagated to existing children). Refuses objects owned by anyone but the user, Administrators or SYSTEM (`EFOREIGNOWNER`) and verifies the result, throwing unless it holds. |
| `checkOwnerOnly(path, { requireProtected? })` | `{ ok, problems, ownedByCurrentUser }`: flags foreign owners, NULL DACLs, any ACE granting another SID, and an unprotected DACL that does not inherit through owner-only directories from a protected one (`requireProtected` demands the object itself be protected, for boundaries). Missing paths throw `ENOENT`. |
| `ensurePrivateDirectoryBoundary(dir)` | Creates the directory private from the first instant, or validates / repairs / refuses an existing one. |
| `writePrivateFileExclusive(path, data)` / `createPrivateDirectory(path)` | Create new objects whose owner-only DACL is part of the create call (POSIX: modes 0600/0700). Throw `EEXIST` rather than reuse a path. |
| `readAcl(path)` / `readPipeAcl(name)` | Owner and DACL entries, for diagnostics. |
| `windowsDaemonPipeName(resinHome, sid?)` | `\\.\pipe\resin-daemon-<16 hex of sha256(lower(SID) + "\0" + lower(resolved home))>`. |
| `createSecurePipeServer(name, onConnection, options?)` | Owner-only pipe server; connections are `stream.Duplex` sockets with `clientPid`. Throws `EADDRINUSE` when the name is taken. |
| `connectVerifiedPipe(name, { timeoutMs? })` | Connects and verifies owner and server process on that same connection before anything is sent; resolves a `Duplex` (`serverPid`), rejects with `reason` `not-running`, `access-denied`, `open-failed`, `foreign-owner` or `foreign-server`. Use it for all client traffic. |
| `verifyPipeServer(name)` | `{ ok, reason? }` presence/diagnostic check on a separate connection (do not use it to authorize another connection). |
| `canonicalLocalPipeName(value)` | `value` with a canonical `\\.\pipe\` prefix when it is a local pipe name, else `undefined`. |
| `useWindowsSecurityPrebuildDirectory(dir)` | Load the native helpers from `dir` (for bundled code such as the install helper); call before first use. |
| `serviceHostExecutablePath()` | Path of the windowless `resin-service-host.exe` used by the per-user scheduled task. |

`@resin/windows-security/testing` exposes probes for tests and diagnostics only: `probeOpenWithUserSidDisabled(path, access)` opens a path or pipe with a restricted token in which the current user's SID is deny-only (so only groups such as Everyone, Users and Authenticated Users can grant access), and `squatPipeForTesting(name, sddl)` claims a pipe name with an arbitrary security descriptor.

## Building the native helpers

The binaries are not checked in. On Windows with Visual Studio Build Tools (C++ workload) and after `pnpm install`:

```powershell
node packages/windows-security/scripts/build-native.mjs --arch x64    # or --arch arm64
```

This writes `prebuilds/win32-<arch>/resin_windows_security.node` (Node-API 8, one binary for every supported Node version) and `prebuilds/win32-<arch>/resin-service-host.exe`, both linked against the static CRT. The script uses `vswhere`, `vcvarsall.bat` and the `node-api-headers` package; node-gyp is not required.

## License

Apache-2.0
