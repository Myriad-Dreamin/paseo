import { isAbsolutePath } from "@/utils/path";

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export interface InlinePathTarget {
  raw: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  columnStart?: number;
}

const FILE_PROTOCOL = "file:";
const INLINE_LINE_FRAGMENT = /^L([0-9]+)(?:C[0-9]+)?(?:-L?([0-9]+)(?:C[0-9]+)?)?$/i;
const INLINE_COLON_LINE_SUFFIX = /^(.+?):([0-9]+)(?:(?::([0-9]+))|-([0-9]+))?$/;
const INLINE_PAREN_LINE_SUFFIX = /^(.+?)\(([0-9]+)(?:,[0-9]+)?(?:-([0-9]+)(?:,[0-9]+)?)?\)$/;
const INLINE_WORD_LINE_SUFFIX = /^(.+?)\s+lines?\s+([0-9]+)(?:-([0-9]+))?$/i;
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

type InlinePathLocation = Pick<InlinePathTarget, "path" | "lineStart" | "lineEnd" | "columnStart">;

type InlineLineLocation = Pick<InlinePathTarget, "lineStart" | "lineEnd" | "columnStart">;

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

function parsePositiveIntegerToken(value: string | undefined): number | null {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseInlineLineLocation(input: {
  lineStartRaw: string | undefined;
  lineEndRaw?: string;
  columnStartRaw?: string;
}): InlineLineLocation | null {
  const lineStart = parsePositiveIntegerToken(input.lineStartRaw);
  if (!lineStart) {
    return null;
  }

  let lineEnd: number | undefined;
  if (input.lineEndRaw) {
    const parsedLineEnd = parsePositiveIntegerToken(input.lineEndRaw);
    if (!parsedLineEnd || parsedLineEnd < lineStart) {
      return null;
    }
    lineEnd = parsedLineEnd;
  }

  let columnStart: number | undefined;
  if (input.columnStartRaw) {
    const parsedColumnStart = parsePositiveIntegerToken(input.columnStartRaw);
    if (!parsedColumnStart) {
      return null;
    }
    columnStart = parsedColumnStart;
  }

  return {
    lineStart,
    lineEnd,
    ...(columnStart ? { columnStart } : {}),
  };
}

function parseColonLineLocation(value: string): InlinePathLocation | null {
  const match = value.match(INLINE_COLON_LINE_SUFFIX);
  if (!match) {
    return null;
  }

  const path = normalizePathToken(match[1] ?? "");
  if (!path) {
    return null;
  }

  const lines = parseInlineLineLocation({
    lineStartRaw: match[2],
    columnStartRaw: match[3],
    lineEndRaw: match[4],
  });
  if (!lines) {
    return null;
  }

  return {
    path,
    ...lines,
  };
}

function parsePathLocation(pathValue: string, hash = ""): InlinePathLocation | null {
  const path = normalizePathToken(pathValue);
  if (!path) {
    return null;
  }

  if (hash) {
    const fragmentLines = parseLineFragment(hash);
    return fragmentLines ? { path, ...fragmentLines } : null;
  }

  return parseColonLineLocation(path) ?? { path, lineStart: undefined, lineEnd: undefined };
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

  const location = parseColonLineLocation(trimmed);
  if (location) {
    return {
      raw: rawValue,
      ...location,
    };
  }

  const match = trimmed.match(INLINE_PAREN_LINE_SUFFIX) ?? trimmed.match(INLINE_WORD_LINE_SUFFIX);
  if (!match) {
    return null;
  }

  const basePathRaw = match[1]?.trim();
  if (!basePathRaw) {
    return null;
  }

  const normalizedPath = normalizePathToken(basePathRaw);
  if (!normalizedPath) {
    return null;
  }

  const lines = parseInlineLineLocation({
    lineStartRaw: match[2],
    lineEndRaw: match[3],
  });
  if (!lines) {
    return null;
  }

  return {
    raw: rawValue,
    path: normalizedPath,
    ...lines,
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

  const location = parsePathLocation(normalizedPath, parsedUrl.hash);
  if (!location) {
    return null;
  }

  return {
    raw: value,
    ...location,
  };
}

function parseAssistantInlinePathLink(value: string): InlinePathTarget | null {
  const inlinePathTarget = parseInlinePathToken(value);
  if (!inlinePathTarget) {
    return null;
  }

  const normalizedPath = normalizePathToken(inlinePathTarget.path);
  if (!normalizedPath || !isAbsolutePath(normalizedPath)) {
    return null;
  }

  return {
    ...inlinePathTarget,
    path: normalizedPath,
  };
}

function buildInlinePathTarget(raw: string, pathValue: string, hash = ""): InlinePathTarget | null {
  const location = parsePathLocation(pathValue, hash);
  return location ? { raw, ...location } : null;
}

function resolveRelativeInlinePathTarget(
  raw: string,
  location: InlinePathLocation,
  options: AssistantHrefParseOptions,
  allowUnrooted: boolean,
): InlinePathTarget | null {
  if (isAbsolutePath(location.path) || !isPlausibleAssistantLocalPath(location.path)) {
    return null;
  }

  if (isHomeRelativePath(location.path)) {
    return {
      raw,
      ...location,
    };
  }

  const workspaceRoot = normalizePathInput(options.workspaceRoot);
  if (!workspaceRoot) {
    return allowUnrooted ? { raw, ...location } : null;
  }

  const path = resolveRelativePathUnderRoot(location.path, workspaceRoot);
  if (!path) {
    return null;
  }

  return {
    raw,
    ...location,
    path,
  };
}

function parseWindowsAssistantFileLink(raw: string, trimmed: string): InlinePathTarget | null {
  const windowsPathMatch = trimmed.match(/^([A-Za-z]:[\\/][^?#]*)(#[^?]+)?$/);
  if (!windowsPathMatch) {
    return null;
  }

  return buildInlinePathTarget(raw, windowsPathMatch[1] ?? "", windowsPathMatch[2] ?? "");
}

function parseRelativeLocationAssistantFileLink(
  raw: string,
  trimmed: string,
  options: AssistantHrefParseOptions,
): InlinePathTarget | null {
  const location = parseColonLineLocation(trimmed);
  if (!location) {
    return null;
  }

  return resolveRelativeInlinePathTarget(raw, location, options, true);
}

function parseAbsoluteAssistantFileLink(raw: string, trimmed: string): InlinePathTarget | null {
  if (!isAbsolutePath(trimmed)) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed, "http://paseo.invalid");
  } catch {
    return null;
  }

  const normalizedPath = normalizePathToken(safeDecodeURIComponent(parsedUrl.pathname));
  const location = normalizedPath ? parsePathLocation(normalizedPath, parsedUrl.hash) : null;
  if (!location || !isAbsolutePath(location.path)) {
    return null;
  }

  return {
    raw,
    ...location,
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

  if (/\s/.test(trimmed)) {
    return null;
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

  const inlinePathTarget = parseAssistantInlinePathLink(trimmed);
  if (inlinePathTarget) {
    return inlinePathTarget;
  }

  const windowsTarget = parseWindowsAssistantFileLink(value, trimmed);
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

  return parseAbsoluteAssistantFileLink(value, trimmed);
}

export function isFileLookingAssistantToken(value: string): boolean {
  const normalized = normalizePathToken(value);
  if (
    !normalized ||
    /\s/.test(normalized) ||
    normalized.includes("?") ||
    normalized.includes("://")
  ) {
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
  const parsed = parseLocalPathParts(value);
  if (!parsed) {
    return null;
  }

  return resolveRelativeInlinePathTarget(
    value,
    { path: parsed.path, ...parsed.lines },
    options,
    false,
  );
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

function isHomeRelativePath(pathValue: string): boolean {
  return pathValue === "~" || pathValue.startsWith("~/") || pathValue.startsWith("~\\");
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
    const lastSegment = segments[segments.length - 1];
    return !isDomainLikePathSegment(firstSegment) && isPlausibleAssistantFileName(lastSegment);
  }

  return isPlausibleAssistantFileName(firstSegment);
}

function isPlausibleAssistantFileName(fileName: string | undefined): boolean {
  if (!fileName) {
    return false;
  }

  if (fileName.startsWith(".") && fileName.length > 1) {
    return true;
  }

  const lastDot = fileName.lastIndexOf(".");
  if (lastDot < 0) {
    return false;
  }

  const extension = fileName.slice(lastDot + 1).toLowerCase();
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

  const decoded = safeDecodeURIComponent(pathname).replace(/\\/g, "/");
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
