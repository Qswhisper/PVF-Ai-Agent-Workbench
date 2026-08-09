"use strict";

const path = require("path");

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_INVALID_SEGMENT_CHAR = /[<>:"|?*\u0000-\u001f]/;

function unsafePvfPath(label: string, value: unknown, reason: string): Error & { code: string; reason: string } {
  const error = new Error(`${label} is unsafe (${reason}): ${JSON.stringify(String(value ?? ""))}`) as Error & {
    code: string;
    reason: string;
  };
  error.code = "UNSAFE_PVF_ENTRY_PATH";
  error.reason = reason;
  return error;
}

function validatePvfEntryPath(value: unknown, label = "PVF entry path"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw unsafePvfPath(label, value, "empty path");
  }
  if (value.includes("\0")) {
    throw unsafePvfPath(label, value, "NUL byte");
  }

  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/")) {
    throw unsafePvfPath(label, value, normalized.startsWith("//") ? "UNC path" : "absolute path");
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    throw unsafePvfPath(label, value, "drive-qualified path");
  }
  if (normalized.includes(":")) {
    throw unsafePvfPath(label, value, "colon or alternate data stream");
  }

  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw unsafePvfPath(label, value, "empty path segment");
    }
    if (segment === "." || segment === "..") {
      throw unsafePvfPath(label, value, `dot segment ${segment}`);
    }
  }
  return normalized;
}

function validateWindowsMaterializationPath(value: unknown, label = "PVF materialization path"): string {
  const normalized = validatePvfEntryPath(value, label);
  for (const segment of normalized.split("/")) {
    if (WINDOWS_INVALID_SEGMENT_CHAR.test(segment)) {
      throw unsafePvfPath(label, value, "Windows-invalid path character");
    }
    if (/[ .]$/.test(segment)) {
      throw unsafePvfPath(label, value, "segment ending in a dot or space");
    }
    if (WINDOWS_RESERVED_NAME.test(segment)) {
      throw unsafePvfPath(label, value, "reserved Windows device name");
    }
  }
  return normalized;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function resolvePvfPathInside(root: string, pvfPath: unknown, label = "PVF materialization path"): string {
  const resolvedRoot = path.resolve(root);
  const normalized = validateWindowsMaterializationPath(pvfPath, label);
  const target = path.resolve(resolvedRoot, ...normalized.split("/"));
  if (!isPathInside(resolvedRoot, target) || target === resolvedRoot) {
    throw unsafePvfPath(label, pvfPath, "resolved path escapes its root");
  }
  return target;
}

module.exports = Object.freeze({
  isPathInside,
  resolvePvfPathInside,
  validatePvfEntryPath,
  validateWindowsMaterializationPath,
});
