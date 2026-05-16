import { isAbsolutePath } from "./path";

export interface InlinePathTarget {
  raw: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  columnStart?: number;
}

const FILE_PROTOCOL = "file:";
const INLINE_LINE_FRAGMENT = /^L([0-9]+)(?:-L?([0-9]+))?$/i;
const ASSISTANT_FILE_EXTENSIONS = new Set([
  "astro",
  "bash",
  "c",
  "cc",
  "cjs",
  "cpp",
  "cs",
  "css",
  "cts",
  "cxx",
  "env",
  "fish",
  "go",
  "gql",
  "gradle",
  "graphql",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "lock",
  "lua",
  "md",
  "mdx",
  "mjs",
  "mts",
  "php",
  "proto",
  "py",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "svelte",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);
const INLINE_PATH_LINE_COLUMN_SUFFIX = /^(.+):([0-9]+):([0-9]+)$/;
const INLINE_PATH_LINE_RANGE_SUFFIX = /^(.+):([0-9]+)-([0-9]+)$/;
const INLINE_PATH_LINE_SUFFIX = /^(.+):([0-9]+)$/;

interface PathLocationSuffixMatch {
  basePathRaw: string;
  lineStartRaw: string;
  lineEndRaw?: string;
  columnStartRaw?: string;
}

export interface AssistantHrefParseOptions {
  workspaceRoot?: string;
}

export type AssistantFileLinkClassification =
  | {
      kind: "external";
      raw: string;
    }
  | {
      kind: "directFile";
      target: InlinePathTarget;
    }
  | {
      kind: "ambiguousFileCandidate";
      target: InlinePathTarget;
    };

export interface NormalizedInlinePathTarget {
  directory: string;
  file?: string;
}

function normalizePathToken(value: string): string | null {
  const trimmed = value
    .trim()
    .replace(/^['"`]/, "")
    .replace(/['"`]$/, "");

  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\\/g, "/");
}

function parseLineFragment(value: string): Pick<InlinePathTarget, "lineStart" | "lineEnd"> | null {
  const rawFragment = value.startsWith("#") ? value.slice(1) : value;
  if (!rawFragment) {
    return { lineStart: undefined, lineEnd: undefined };
  }

  const lineMatch = rawFragment.match(INLINE_LINE_FRAGMENT);
  const lineStart = lineMatch?.[1] ? parseInt(lineMatch[1], 10) : undefined;
  const lineEnd = lineMatch?.[2] ? parseInt(lineMatch[2], 10) : undefined;

  if (
    (lineStart !== undefined && (!Number.isFinite(lineStart) || lineStart <= 0)) ||
    (lineEnd !== undefined && (!Number.isFinite(lineEnd) || lineEnd <= 0)) ||
    (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart)
  ) {
    return null;
  }

  return { lineStart, lineEnd };
}

function matchPathLocationSuffix(value: string): PathLocationSuffixMatch | null {
  const columnMatch = value.match(INLINE_PATH_LINE_COLUMN_SUFFIX);
  if (columnMatch) {
    return {
      basePathRaw: columnMatch[1] ?? "",
      lineStartRaw: columnMatch[2] ?? "",
      columnStartRaw: columnMatch[3],
    };
  }

  const rangeMatch = value.match(INLINE_PATH_LINE_RANGE_SUFFIX);
  if (rangeMatch) {
    return {
      basePathRaw: rangeMatch[1] ?? "",
      lineStartRaw: rangeMatch[2] ?? "",
      lineEndRaw: rangeMatch[3],
    };
  }

  const lineMatch = value.match(INLINE_PATH_LINE_SUFFIX);
  if (!lineMatch) {
    return null;
  }

  return {
    basePathRaw: lineMatch[1] ?? "",
    lineStartRaw: lineMatch[2] ?? "",
  };
}

function parsePositiveIntegerToken(value: string | undefined): number | null {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseLineEndToken(
  value: string | undefined,
  lineStart: number,
): number | undefined | null {
  if (!value) {
    return undefined;
  }
  const lineEnd = parsePositiveIntegerToken(value);
  if (!lineEnd || lineEnd < lineStart) {
    return null;
  }
  return lineEnd;
}

function parseColumnStartToken(value: string | undefined): number | undefined | null {
  if (!value) {
    return undefined;
  }
  return parsePositiveIntegerToken(value);
}

function parsePathLocationSuffix(
  value: string,
): Pick<InlinePathTarget, "path" | "lineStart" | "lineEnd" | "columnStart"> | null {
  const match = matchPathLocationSuffix(value);
  if (!match) {
    return null;
  }

  const basePathRaw = match.basePathRaw.trim();
  if (!basePathRaw) {
    return null;
  }

  const normalizedPath = normalizePathToken(basePathRaw);
  if (!normalizedPath) {
    return null;
  }

  const lineStart = parsePositiveIntegerToken(match.lineStartRaw);
  if (!lineStart) {
    return null;
  }

  const lineEnd = parseLineEndToken(match.lineEndRaw, lineStart);
  if (lineEnd === null) {
    return null;
  }

  const columnStart = parseColumnStartToken(match.columnStartRaw);
  if (columnStart === null) {
    return null;
  }

  return {
    path: normalizedPath,
    lineStart,
    lineEnd,
    ...(columnStart ? { columnStart } : {}),
  };
}

function parseHrefPathAndLines(
  pathValue: string,
  hash: string,
): Pick<InlinePathTarget, "path" | "lineStart" | "lineEnd" | "columnStart"> | null {
  const fragmentLines = parseLineFragment(hash);
  if (!fragmentLines) {
    return null;
  }

  const suffixLocation = parsePathLocationSuffix(pathValue);
  if (!hash) {
    if (suffixLocation) {
      return suffixLocation;
    }
  }

  return {
    path: suffixLocation?.path ?? pathValue,
    ...fragmentLines,
  };
}

/**
 * Strict VSCode-style markers only.
 *
 * Supported:
 * - `filename:linenumber`
 * - `filename:linenumber:columnnumber`
 * - `filename:lineStart-lineEnd`
 *
 * Not supported (by design):
 * - plain `filename` (no line)
 * - `:linenumber` (range-only)
 */
export function parseInlinePathToken(value: string): InlinePathTarget | null {
  const rawValue = value ?? "";
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  // Avoid accidentally treating URLs as file paths.
  if (trimmed.includes("://")) {
    return null;
  }

  const location = parsePathLocationSuffix(trimmed);
  if (!location) {
    return null;
  }

  return {
    raw: rawValue,
    ...location,
  };
}

export function parseFileProtocolUrl(value: string): InlinePathTarget | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== FILE_PROTOCOL) {
    return null;
  }

  const normalizedPath = normalizeFileUrlPath(parsedUrl.pathname);
  if (!normalizedPath) {
    return null;
  }

  const hrefPath = parseHrefPathAndLines(normalizedPath, parsedUrl.hash);
  if (!hrefPath) {
    return null;
  }

  return {
    raw: value,
    ...hrefPath,
  };
}

function parseAssistantInlinePathLink(
  value: string,
  options: AssistantHrefParseOptions,
): InlinePathTarget | null {
  const inlinePathTarget = parseInlinePathToken(value);
  if (!inlinePathTarget) {
    return null;
  }

  const normalizedPath = normalizePathToken(inlinePathTarget.path);
  if (!normalizedPath || !isAbsolutePath(normalizedPath)) {
    return null;
  }

  if (!isAllowedAbsolutePath(normalizedPath, options.workspaceRoot)) {
    return null;
  }

  return {
    ...inlinePathTarget,
    path: normalizedPath,
  };
}

function parseWindowsAssistantFileLink(
  raw: string,
  trimmed: string,
  options: AssistantHrefParseOptions,
): InlinePathTarget | null {
  const windowsPathMatch = trimmed.match(/^([A-Za-z]:[\\/][^?#]*)(#[^?]+)?$/);
  if (!windowsPathMatch) {
    return null;
  }

  const normalizedPath = normalizePathToken(windowsPathMatch[1] ?? "");
  const hrefPath = normalizedPath
    ? parseHrefPathAndLines(normalizedPath, windowsPathMatch[2] ?? "")
    : null;
  if (!hrefPath || !isAllowedAbsolutePath(hrefPath.path, options.workspaceRoot)) {
    return null;
  }

  return {
    raw,
    ...hrefPath,
  };
}

function parseRelativeLocationAssistantFileLink(
  raw: string,
  trimmed: string,
  options: AssistantHrefParseOptions,
): InlinePathTarget | null {
  const relativeLocation = parsePathLocationSuffix(trimmed);
  if (!relativeLocation || isAbsolutePath(relativeLocation.path)) {
    return null;
  }

  if (!isPlausibleAssistantLocalPath(relativeLocation.path)) {
    return null;
  }

  const workspaceRoot = normalizePathInput(options.workspaceRoot);
  if (!workspaceRoot) {
    return {
      raw,
      ...relativeLocation,
    };
  }

  const normalizedPath = resolveRelativePathUnderRoot(relativeLocation.path, workspaceRoot);
  if (!normalizedPath) {
    return null;
  }

  return {
    raw,
    ...relativeLocation,
    path: normalizedPath,
  };
}

function parseAbsoluteAssistantFileLink(
  raw: string,
  trimmed: string,
  options: AssistantHrefParseOptions,
): InlinePathTarget | null {
  if (!isAbsolutePath(trimmed)) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed, "http://paseo.invalid");
  } catch {
    return null;
  }

  const normalizedPath = normalizePathToken(decodeURIComponent(parsedUrl.pathname));
  const hrefPath = normalizedPath ? parseHrefPathAndLines(normalizedPath, parsedUrl.hash) : null;
  if (!hrefPath || !isAbsolutePath(hrefPath.path)) {
    return null;
  }

  if (!isAllowedAbsolutePath(hrefPath.path, options.workspaceRoot)) {
    return null;
  }

  return {
    raw,
    ...hrefPath,
  };
}

export function classifyAssistantFileLink(
  value: string,
  options: AssistantHrefParseOptions = {},
): AssistantFileLinkClassification | null {
  const raw = value ?? "";
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (isExternalHref(trimmed)) {
    return {
      kind: "external",
      raw,
    };
  }

  const target = parseAssistantFileLink(trimmed, options);
  if (!target) {
    return null;
  }

  if (isAmbiguousWorkspaceCandidate(trimmed, target, options.workspaceRoot)) {
    return {
      kind: "ambiguousFileCandidate",
      target,
    };
  }

  return {
    kind: "directFile",
    target,
  };
}

export function parseAssistantFileLink(
  value: string,
  options: AssistantHrefParseOptions = {},
): InlinePathTarget | null {
  const fileUrlTarget = parseFileProtocolUrl(value);
  if (fileUrlTarget) {
    return fileUrlTarget;
  }

  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  if (isExternalHref(trimmed)) {
    return null;
  }

  const inlinePathTarget = parseAssistantInlinePathLink(trimmed, {
    workspaceRoot: options.workspaceRoot,
  });
  if (inlinePathTarget) {
    return inlinePathTarget;
  }

  const windowsTarget = parseWindowsAssistantFileLink(value, trimmed, options);
  if (windowsTarget) {
    return windowsTarget;
  }

  const relativeLocationTarget = parseRelativeLocationAssistantFileLink(value, trimmed, options);
  if (relativeLocationTarget) {
    return relativeLocationTarget;
  }

  const relativeTarget = parseWorkspaceRelativeFileLink(trimmed, {
    workspaceRoot: options.workspaceRoot,
  });
  if (relativeTarget) {
    return relativeTarget;
  }

  return parseAbsoluteAssistantFileLink(value, trimmed, options);
}

export function isFileLookingAssistantToken(value: string): boolean {
  const normalized = normalizePathToken(value);
  if (!normalized || normalized.includes("?") || normalized.includes("://")) {
    return false;
  }

  const path = getHeuristicLocalPath(normalized);
  if (!path) {
    return false;
  }

  return isPlausibleAssistantLocalPath(path);
}

function parseWorkspaceRelativeFileLink(
  value: string,
  options: AssistantHrefParseOptions,
): InlinePathTarget | null {
  const workspaceRoot = normalizePathInput(options.workspaceRoot);
  if (!workspaceRoot) {
    return null;
  }

  const parsed = parseLocalPathParts(value);
  if (!parsed || isAbsolutePath(parsed.path)) {
    return null;
  }

  const normalizedPath = resolveRelativePathUnderRoot(parsed.path, workspaceRoot);
  if (!normalizedPath) {
    return null;
  }

  return {
    raw: value,
    path: normalizedPath,
    ...parsed.lines,
  };
}

function parseLocalPathParts(
  value: string,
): { path: string; lines: Pick<InlinePathTarget, "lineStart" | "lineEnd" | "columnStart"> } | null {
  const normalized = normalizePathToken(value);
  if (!normalized || normalized.includes("?")) {
    return null;
  }

  const hashIndex = normalized.indexOf("#");
  const beforeHash = hashIndex >= 0 ? normalized.slice(0, hashIndex) : normalized;
  const hash = hashIndex >= 0 ? normalized.slice(hashIndex) : "";
  const fragmentLines = parseLineFragment(hash);
  if (!fragmentLines) {
    return null;
  }

  const inlinePathTarget = parseInlinePathToken(beforeHash);
  if (inlinePathTarget) {
    if (!isPlausibleAssistantLocalPath(inlinePathTarget.path)) {
      return null;
    }

    return {
      path: inlinePathTarget.path,
      lines: {
        lineStart: inlinePathTarget.lineStart,
        lineEnd: inlinePathTarget.lineEnd,
        columnStart: inlinePathTarget.columnStart,
      },
    };
  }

  if (!beforeHash || beforeHash.includes(":")) {
    return null;
  }

  if (!isPlausibleAssistantLocalPath(beforeHash)) {
    return null;
  }

  return {
    path: beforeHash,
    lines: fragmentLines,
  };
}

export function normalizeInlinePathTarget(
  rawPath: string,
  cwd?: string,
): NormalizedInlinePathTarget | null {
  if (!rawPath) {
    return null;
  }

  const normalizedInput = normalizePathInput(rawPath);
  if (!normalizedInput) {
    return null;
  }

  let normalized = normalizedInput;
  const cwdRelative = resolvePathAgainstCwd(normalized, cwd);
  if (cwdRelative) {
    normalized = cwdRelative;
  }

  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2) || ".";
  }

  if (!normalized.length) {
    normalized = ".";
  }

  if (normalized === ".") {
    return { directory: "." };
  }

  if (normalized.endsWith("/")) {
    const dir = normalized.replace(/\/+$/, "");
    return { directory: dir.length > 0 ? dir : "." };
  }

  const lastSlash = normalized.lastIndexOf("/");
  const directory = lastSlash >= 0 ? normalized.slice(0, lastSlash) : ".";

  return {
    directory: directory.length > 0 ? directory : ".",
    file: normalized,
  };
}

function isAllowedAbsolutePath(pathValue: string, workspaceRoot?: string): boolean {
  const normalizedWorkspaceRoot = normalizePathInput(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    return true;
  }

  const comparePath = normalizePathForCompare(pathValue);
  const compareWorkspaceRoot = normalizePathForCompare(
    normalizedWorkspaceRoot.replace(/\/+$/, "") || "/",
  );
  const comparePrefix = compareWorkspaceRoot === "/" ? "/" : `${compareWorkspaceRoot}/`;

  return comparePath === compareWorkspaceRoot || comparePath.startsWith(comparePrefix);
}

function isExternalHref(value: string): boolean {
  if (value.includes("://")) {
    return !value.toLowerCase().startsWith(`${FILE_PROTOCOL}//`);
  }

  const inlinePathTarget = parseInlinePathToken(value);
  if (inlinePathTarget) {
    return false;
  }

  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value);
}

function isAmbiguousWorkspaceCandidate(
  value: string,
  target: InlinePathTarget,
  workspaceRoot?: string,
): boolean {
  const normalizedWorkspaceRoot = normalizePathInput(workspaceRoot);
  if (!normalizedWorkspaceRoot || !isAllowedAbsolutePath(target.path, normalizedWorkspaceRoot)) {
    return false;
  }

  const parsed = parseLocalPathParts(value);
  if (!parsed || isAbsolutePath(parsed.path)) {
    return false;
  }

  return !parsed.path.includes("/");
}

function getHeuristicLocalPath(value: string): string | null {
  const hashIndex = value.indexOf("#");
  const beforeHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  if (!parseLineFragment(hash)) {
    return null;
  }

  const inlinePathTarget = parseInlinePathToken(beforeHash);
  if (inlinePathTarget) {
    return inlinePathTarget.path;
  }

  if (!beforeHash || beforeHash.includes(":")) {
    return null;
  }

  return beforeHash;
}

function isPlausibleAssistantLocalPath(pathValue: string): boolean {
  const normalized = normalizePathToken(pathValue);
  if (!normalized) {
    return false;
  }

  if (isAbsolutePath(normalized)) {
    return true;
  }

  const explicitRelative =
    normalized.startsWith("./") || normalized.startsWith("../") || normalized.startsWith("~/");
  if (explicitRelative) {
    return true;
  }

  const segments = normalized.split("/").filter(Boolean);
  const firstSegment = segments[0];
  if (!firstSegment) {
    return false;
  }

  if (segments.length > 1) {
    return !isDomainLikePathSegment(firstSegment);
  }

  if (firstSegment.startsWith(".") && firstSegment.length > 1) {
    return true;
  }

  const lastDot = firstSegment.lastIndexOf(".");
  if (lastDot < 0) {
    return true;
  }

  const extension = firstSegment.slice(lastDot + 1).toLowerCase();
  return ASSISTANT_FILE_EXTENSIONS.has(extension);
}

function isDomainLikePathSegment(segment: string): boolean {
  return /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(segment);
}

function resolveRelativePathUnderRoot(pathValue: string, workspaceRoot: string): string | null {
  const normalizedPath = normalizePathToken(pathValue);
  if (!normalizedPath || isAbsolutePath(normalizedPath)) {
    return null;
  }

  const root = workspaceRoot.replace(/\/+$/, "") || "/";
  const pathSegments = normalizedPath.split("/");
  const resolvedSegments: string[] = [];
  for (const segment of pathSegments) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (resolvedSegments.length === 0) {
        return null;
      }
      resolvedSegments.pop();
      continue;
    }
    resolvedSegments.push(segment);
  }

  if (resolvedSegments.length === 0) {
    return root;
  }

  return root === "/" ? `/${resolvedSegments.join("/")}` : `${root}/${resolvedSegments.join("/")}`;
}

function normalizeFileUrlPath(pathname: string): string | null {
  if (!pathname) {
    return null;
  }

  const decoded = decodeURIComponent(pathname).replace(/\\/g, "/");
  if (!decoded) {
    return null;
  }

  if (/^\/[A-Za-z]:\//.test(decoded)) {
    return decoded.slice(1);
  }

  return decoded;
}

function normalizePathInput(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value
    .trim()
    .replace(/^['"`]/, "")
    .replace(/['"`]$/, "");
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function resolvePathAgainstCwd(pathValue: string, cwd?: string): string | null {
  const normalizedCwd = normalizePathInput(cwd);
  if (!normalizedCwd || !isAbsolutePath(pathValue) || !isAbsolutePath(normalizedCwd)) {
    return null;
  }

  const normalizedCwdBase = normalizedCwd.replace(/\/+$/, "") || "/";
  const comparePath = normalizePathForCompare(pathValue);
  const compareCwd = normalizePathForCompare(normalizedCwdBase);
  const prefix = normalizedCwdBase === "/" ? "/" : `${normalizedCwdBase}/`;
  const comparePrefix = normalizePathForCompare(prefix);

  if (comparePath === compareCwd) {
    return ".";
  }

  if (comparePath.startsWith(comparePrefix)) {
    return pathValue.slice(prefix.length) || ".";
  }

  return null;
}

function normalizePathForCompare(value: string): string {
  return /^[A-Za-z]:/.test(value) ? value.toLowerCase() : value;
}
