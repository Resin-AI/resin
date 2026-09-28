import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AclDescription,
  checkOwnerOnly,
  connectVerifiedPipe,
  createPrivateDirectory,
  currentUserSid,
  ensureOwnerOnly,
  ensurePrivateDirectoryBoundary,
  isLocalPipeName,
  isWindowsSecurityAvailable,
  ownerOnlyProblems,
  serviceHostExecutablePath,
  useWindowsSecurityPrebuildDirectory,
  verifyPipeServer,
  windowsDaemonPipeName,
  writePrivateFileExclusive,
} from "../src/index.js";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const OTHER_SID = "S-1-5-21-1111111111-2222222222-3333333333-1002";

describe("windowsDaemonPipeName", () => {
  it("derives a stable per-user, per-home local pipe name", () => {
    const name = windowsDaemonPipeName("C:\\Users\\alice\\.resin", SID);
    expect(name).toMatch(/^\\\\\.\\pipe\\resin-daemon-[0-9a-f]{16}$/);
    expect(windowsDaemonPipeName("C:\\Users\\alice\\.resin", SID)).toBe(name);
    expect(isLocalPipeName(name)).toBe(true);
  });

  it("normalizes case, separators and trailing slashes of the home and the SID", () => {
    const name = windowsDaemonPipeName("C:\\Users\\alice\\.resin", SID);
    expect(windowsDaemonPipeName("c:/users/ALICE/.resin/", SID.toLowerCase())).toBe(name);
    expect(windowsDaemonPipeName("C:\\Users\\alice\\.resin\\\\", SID)).toBe(name);
  });

  it("separates users and Resin homes", () => {
    const name = windowsDaemonPipeName("C:\\Users\\alice\\.resin", SID);
    expect(windowsDaemonPipeName("C:\\Users\\alice\\.resin", OTHER_SID)).not.toBe(name);
    expect(windowsDaemonPipeName("D:\\resin-home", SID)).not.toBe(name);
  });
});

describe("ownerOnlyProblems", () => {
  const ownerOnly: AclDescription = {
    owner: SID,
    protected: true,
    daclPresent: true,
    entries: [
      { type: "deny", sid: "S-1-5-2", mask: 0x10000000, inherited: false, inheritOnly: false },
      { type: "allow", sid: SID, mask: 0x1f01ff, inherited: false, inheritOnly: false },
    ],
  };

  it("accepts an owner-only DACL, and an inherited one only when protection is not required", () => {
    expect(ownerOnlyProblems(ownerOnly, SID.toLowerCase())).toEqual([]);
    expect(ownerOnlyProblems(ownerOnly, SID, { requireProtected: true })).toEqual([]);
    const inherited: AclDescription = {
      ...ownerOnly,
      protected: false,
      entries: [{ type: "allow", sid: SID, mask: 0x1f01ff, inherited: true, inheritOnly: false }],
    };
    // Descendants: durable only through a protected ancestor, which checkOwnerOnly verifies.
    expect(ownerOnlyProblems(inherited, SID)).toEqual([]);
    // Security boundaries (Resin home, private directories, trust roots) must be protected.
    expect(ownerOnlyProblems(inherited, SID, { requireProtected: true })).toEqual([
      "does not have a protected DACL (ancestors can widen it through inheritance)",
    ]);
  });

  it("reports foreign owners, NULL DACLs and grants to anyone else", () => {
    expect(ownerOnlyProblems({ ...ownerOnly, owner: OTHER_SID }, SID)).toEqual([
      `is owned by ${OTHER_SID}, not the current user ${SID}`,
    ]);
    expect(ownerOnlyProblems({ ...ownerOnly, daclPresent: false, entries: [] }, SID)).toEqual([
      "has a NULL DACL (everyone has full access)",
    ]);
    const problems = ownerOnlyProblems(
      {
        ...ownerOnly,
        entries: [
          ...ownerOnly.entries,
          { type: "allow", sid: "S-1-1-0", mask: 0x120089, inherited: true, inheritOnly: false },
          { type: "allow", sid: "S-1-3-0", mask: 0x10000000, inherited: false, inheritOnly: true },
          { type: "other", sid: null, mask: 0, inherited: false, inheritOnly: false },
        ],
      },
      SID,
    );
    expect(problems).toEqual([
      "grants access to S-1-1-0",
      "grants access to S-1-3-0 (inheritable to new children)",
      "has an unsupported ACE type granting access to an unknown SID",
    ]);
  });

  it("accepts objects an elevated administrator or LocalSystem created, if only the user has access", () => {
    // An elevated admin token makes BUILTIN\Administrators the default owner of new objects.
    expect(ownerOnlyProblems({ ...ownerOnly, owner: "S-1-5-32-544" }, SID)).toEqual([]);
    expect(
      ownerOnlyProblems({ ...ownerOnly, owner: "S-1-5-18" }, SID, { requireProtected: true }),
    ).toEqual([]);
    // The owner exemption never admits extra grants.
    expect(
      ownerOnlyProblems(
        {
          ...ownerOnly,
          owner: "S-1-5-32-544",
          entries: [
            ...ownerOnly.entries,
            {
              type: "allow",
              sid: "S-1-5-32-544",
              mask: 0x1f01ff,
              inherited: false,
              inheritOnly: false,
            },
          ],
        },
        SID,
      ),
    ).toEqual(["grants access to S-1-5-32-544"]);
    // Standard users' SIDs stay foreign, as do well-known groups other than the two above.
    expect(ownerOnlyProblems({ ...ownerOnly, owner: "S-1-5-32-545" }, SID)).toEqual([
      `is owned by S-1-5-32-545, not the current user ${SID}`,
    ]);
  });
});

describe.skipIf(process.platform === "win32")("off Windows", () => {
  it("loads without the native helper and degrades to POSIX semantics", () => {
    expect(isWindowsSecurityAvailable()).toBe(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-winsec-"));
    try {
      expect(() => ensureOwnerOnly(dir, { directory: true })).not.toThrow();
      expect(checkOwnerOnly(dir)).toEqual({ ok: true, problems: [], ownedByCurrentUser: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a prebuild directory without the addon", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-winsec-prebuild-"));
    try {
      expect(() => useWindowsSecurityPrebuildDirectory(dir)).toThrow(/is missing/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates private files and directories with POSIX modes, never reusing a path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-winsec-create-"));
    try {
      const file = path.join(dir, "secret");
      writePrivateFileExclusive(file, "value");
      expect(fs.readFileSync(file, "utf8")).toBe("value");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(() => writePrivateFileExclusive(file, "other")).toThrow(
        expect.objectContaining({ code: "EEXIST" }),
      );
      const child = path.join(dir, "child");
      createPrivateDirectory(child);
      expect(fs.statSync(child).mode & 0o777).toBe(0o700);
      expect(() => createPrivateDirectory(child)).toThrow(
        expect.objectContaining({ code: "EEXIST" }),
      );
      const nested = path.join(dir, "a", "b");
      ensurePrivateDirectoryBoundary(nested);
      ensurePrivateDirectoryBoundary(nested);
      expect(fs.statSync(nested).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to connect to pipes off Windows", async () => {
    await expect(connectVerifiedPipe("\\\\server\\pipe\\resin")).rejects.toMatchObject({
      reason: "open-failed",
    });
    await expect(connectVerifiedPipe("\\\\.\\pipe\\resin")).rejects.toThrow(
      /only available on Windows/,
    );
  });

  it("explains that Windows-only operations need Windows", () => {
    expect(() => currentUserSid()).toThrow(/only available on Windows/);
    expect(() => verifyPipeServer("\\\\.\\pipe\\resin-daemon-test")).toThrow(
      /only available on Windows/,
    );
    expect(() => windowsDaemonPipeName("C:\\resin")).toThrow(/only available on Windows/);
    expect(() => serviceHostExecutablePath()).toThrow(/only available on Windows/);
  });
});
