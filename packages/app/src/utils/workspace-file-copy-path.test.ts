import { describe, expect, it } from "vitest";
import { resolveWorkspaceFileCopyPath } from "@/utils/workspace-file-copy-path";

describe("resolveWorkspaceFileCopyPath", () => {
  it("passes absolute POSIX and Windows paths through unchanged", () => {
    expect(
      resolveWorkspaceFileCopyPath({ path: "/tmp/file.ts", workspaceDirectory: "/repo" }),
    ).toBe("/tmp/file.ts");
    expect(
      resolveWorkspaceFileCopyPath({ path: "C:\\work\\file.ts", workspaceDirectory: "/repo" }),
    ).toBe("C:\\work\\file.ts");
  });

  it("joins a relative path with an absolute directory", () => {
    expect(resolveWorkspaceFileCopyPath({ directory: "/repo/src", path: "index.ts" })).toBe(
      "/repo/src/index.ts",
    );
  });

  it("resolves a workspace-relative directory without duplicating it", () => {
    expect(
      resolveWorkspaceFileCopyPath({
        workspaceDirectory: "/repo",
        directory: "src",
        path: "src/index.ts",
      }),
    ).toBe("/repo/src/index.ts");
  });

  it("uses the workspace root for a relative file path", () => {
    expect(
      resolveWorkspaceFileCopyPath({ workspaceDirectory: "C:\\repo", path: "src\\app.ts" }),
    ).toBe("C:\\repo\\src\\app.ts");
  });
});
