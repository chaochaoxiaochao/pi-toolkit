import assert from "node:assert/strict";

export function applyOperations(input, operations, applyUpdate) {
  const files = new Map(Object.entries(input));
  for (const operation of operations) {
    if (operation.action === "add") {
      if (files.has(operation.path)) throw new Error(`Cannot add existing file ${operation.path}`);
      files.set(operation.path, operation.content);
      continue;
    }
    if (!files.has(operation.path)) throw new Error(`Missing source file ${operation.path}`);
    if (operation.action === "delete") {
      files.delete(operation.path);
      continue;
    }
    const groups = operation.chunkGroups ?? [operation.chunks];
    const after = groups.reduce(
      (content, chunks) => applyUpdate(content, chunks, operation.path),
      files.get(operation.path),
    );
    if (operation.moveTo) {
      if (files.has(operation.moveTo)) throw new Error(`Cannot move over existing file ${operation.moveTo}`);
      files.delete(operation.path);
      files.set(operation.moveTo, after);
    } else {
      files.set(operation.path, after);
    }
  }
  return Object.fromEntries([...files].sort(([left], [right]) => left.localeCompare(right)));
}

export function runPatchCase(testCase, parse, applyUpdate, expectedOutcome) {
  try {
    const actual = applyOperations(testCase.input, parse(testCase.patch), applyUpdate);
    if (expectedOutcome !== "pass") {
      assert.fail(`${testCase.id}: expected ${expectedOutcome}, but patch succeeded`);
    }
    assert.deepEqual(actual, testCase.expected, `${testCase.id}: final filesystem differs`);
    return "pass";
  } catch (error) {
    if (expectedOutcome === "pass") throw error;
    return "fail";
  }
}
