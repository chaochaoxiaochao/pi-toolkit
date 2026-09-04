import { relative, resolve, sep } from "node:path";

export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?
hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
filename: /(.+)/
add_line: "+" /(.*)/ LF -> line
change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF
%import common.LF`;

export function parsePatch(patch) {
  const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
  if (lines[0]?.trim() !== "*** Begin Patch") throw new Error("The first line of the patch must be '*** Begin Patch'");
  if (lines.at(-1)?.trim() !== "*** End Patch") throw new Error("The last line of the patch must be '*** End Patch'");
  const operations = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index];
    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length);
      index += 1;
      const content = [];
      while (index < lines.length - 1 && !lines[index].startsWith("*** ")) {
        if (!lines[index].startsWith("+")) throw new Error(`Invalid add line ${index + 1}`);
        content.push(lines[index].slice(1));
        index += 1;
      }
      if (content.length === 0) throw new Error(`Add file hunk for path '${path}' is empty`);
      operations.push({ action: "add", path, content: `${content.join("\n")}\n` });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length);
      if (!path) throw new Error(`Delete file hunk on line ${index + 1} has an empty path`);
      operations.push({ action: "delete", path });
      index += 1;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length);
      index += 1;
      let moveTo;
      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = lines[index].slice("*** Move to: ".length);
        index += 1;
      }
      const chunks = [];
      while (index < lines.length - 1 && !lines[index].startsWith("*** ")) {
        let context;
        if (lines[index] === "@@" || lines[index].startsWith("@@ ")) {
          context = lines[index].slice(2).trim() || undefined;
          index += 1;
        }
        const oldLines = [];
        const newLines = [];
        const contextLineIndices = [];
        while (index < lines.length - 1 && !lines[index].startsWith("*** ") && !lines[index].startsWith("@@")) {
          const change = lines[index];
          const marker = change[0];
          if (!["+", "-", " "].includes(marker)) throw new Error(`Invalid update line ${index + 1}`);
          const text = change.slice(1);
          if (marker === "+") newLines.push(text);
          else if (marker === "-") oldLines.push(text);
          else {
            contextLineIndices.push([oldLines.length, newLines.length]);
            oldLines.push(text);
            newLines.push(text);
          }
          index += 1;
        }
        const endOfFile = lines[index] === "*** End of File";
        if (endOfFile) index += 1;
        if (oldLines.length === 0 && newLines.length === 0) throw new Error(`Empty update chunk on line ${index + 1}`);
        chunks.push({ context, oldLines, newLines, contextLineIndices, endOfFile });
      }
      if (chunks.length === 0) throw new Error(`Update file hunk for path '${path}' is empty`);
      operations.push({ action: "update", path, moveTo, chunks });
      continue;
    }
    throw new Error(`Invalid hunk header on line ${index + 1}: ${line}`);
  }
  if (operations.length === 0) throw new Error("Patch contains no file operations");
  const targets = operations.flatMap((operation) => [operation.path, operation.moveTo].filter(Boolean));
  if (new Set(targets).size !== targets.length) throw new Error("Multiple operations target the same path");
  return operations;
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function findCandidates(lines, pattern, start, eof, compare) {
  const candidates = [];
  for (let index = start; index + pattern.length <= lines.length; index += 1) {
    if (pattern.every((line, offset) => compare(lines[index + offset], line))) candidates.push(index);
  }
  candidates.sort((left, right) => eof ? right - left : left - right);
  return candidates;
}

function locate(lines, pattern, start, eof, label) {
  if (pattern.length === 0) return Math.min(start, lines.length);
  const comparisons = [
    (left, right) => left === right,
    (left, right) => left.trimEnd() === right.trimEnd(),
    (left, right) => left.trim() === right.trim(),
  ];
  for (const compare of comparisons) {
    const candidates = findCandidates(lines, pattern, start, eof, compare);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) throw new Error(`Ambiguous ${label || "patch"} match: ${candidates.length} regions found`);
  }
  throw new Error(`Failed to find expected lines${label ? ` in ${label}` : ""}: ${pattern.join("\\n")}`);
}

export function applyUpdate(content, chunks, path) {
  const bom = content.startsWith("\ufeff") ? "\ufeff" : "";
  const withoutBom = bom ? content.slice(1) : content;
  const ending = withoutBom.includes("\r\n") ? "\r\n" : "\n";
  const normalized = normalizeLineEndings(withoutBom);
  const hadFinalNewline = normalized.endsWith("\n");
  const lines = normalized === "" ? [] : normalized.split("\n");
  if (hadFinalNewline) lines.pop();
  const replacements = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.context !== undefined) cursor = locate(lines, [chunk.context], cursor, false, path) + 1;
    const start = locate(lines, chunk.oldLines, cursor, chunk.endOfFile, path);
    replacements.push({ start, length: chunk.oldLines.length, next: chunk.newLines });
    cursor = start + chunk.oldLines.length;
  }
  const output = [...lines];
  for (const replacement of [...replacements].reverse()) output.splice(replacement.start, replacement.length, ...replacement.next);
  let next = output.join("\n");
  if (hadFinalNewline || next.length > 0) next += "\n";
  if (ending === "\r\n") next = next.replace(/\n/g, "\r\n");
  return bom + next;
}

export function resolveWorkspacePath(cwd, rawPath) {
  if (!rawPath || rawPath.includes("\0")) throw new Error(`Unsafe patch path: ${rawPath}`);
  const absolute = resolve(cwd, rawPath);
  const rel = relative(cwd, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Patch path escapes workspace: ${rawPath}`);
  return absolute;
}
