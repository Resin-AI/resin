import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { recordedFileUrlPath } from "../src/index.js";

// A recorded working directory names a path on the machine that recorded it, whatever host decodes it.
describe("recordedFileUrlPath", () => {
  it("decodes a POSIX file URL to a POSIX path on every host", () => {
    expect(recordedFileUrlPath("file:///work/demo")).toBe("/work/demo");
    expect(recordedFileUrlPath("file://localhost/app")).toBe("/app");
    expect(recordedFileUrlPath("file:///tmp/with%20space")).toBe("/tmp/with space");
  });

  it("decodes a Windows drive or UNC file URL to a Windows path on every host", () => {
    expect(recordedFileUrlPath("file:///C:/Users/me/project")).toBe("C:\\Users\\me\\project");
    expect(recordedFileUrlPath("file:///d:/")).toBe("d:\\");
    expect(recordedFileUrlPath("file://server/share/dir")).toBe("\\\\server\\share\\dir");
  });

  it("rejects a URL that names no path", () => {
    expect(() => recordedFileUrlPath("file:///work/a%2Fb")).toThrow();
    expect(() => recordedFileUrlPath("file:///C:/a%5Cb")).toThrow();
    expect(() => recordedFileUrlPath("https://example.com/work")).toThrow();
  });

  it("agrees with Node's fileURLToPath for the flavour it picks", () => {
    for (const url of ["file:///work/%C3%A9t%C3%A9", "file:///srv/a%20b/c"]) {
      expect(recordedFileUrlPath(url)).toBe(fileURLToPath(url, { windows: false }));
    }
    for (const url of ["file:///C:/a%20b/%C3%A9", "file:///C:", "file://nas/share/x%23y"]) {
      expect(recordedFileUrlPath(url)).toBe(fileURLToPath(url, { windows: true }));
    }
  });
});
