import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cli = join(import.meta.dirname, "../bin/pi-worktree");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-cli-"));
  const repo = join(root, "main checkout");
  mkdirSync(repo);
  const git = (args, cwd = repo) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(repo, "file"), "base\n");
  git(["add", "."]);
  git(["commit", "-qm", "base"]);
  const run = (args, cwd = repo, input = "") => spawnSync("bash", [cli, ...args], { cwd, input, encoding: "utf8" });
  const create = (name, cwd = repo, args = []) => {
    const result = run(["create", "--json", ...args, name], cwd);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  return { root, repo, git, run, create, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("a linked worktree creates a sibling from its own HEAD, not the main checkout", () => {
  const f = fixture();
  try {
    const a = f.create("A");
    f.git(["commit", "--allow-empty", "-qm", "A commit"], a.path);
    const base = f.git(["rev-parse", "HEAD"], a.path);
    writeFileSync(join(a.path, "dirty"), "do not copy");
    const nested = join(a.path, "nested");
    mkdirSync(nested);
    const b = f.create("B", nested);
    assert.equal(b.path, join(f.repo, ".worktrees/B"));
    assert.equal(f.git(["rev-parse", "HEAD"], b.path), base);
    assert.equal(existsSync(join(b.path, "dirty")), false);
    assert.equal(readFileSync(join(a.path, "dirty"), "utf8"), "do not copy");
    const explicit = f.create("explicit", a.path, ["--base", "main"]);
    assert.equal(f.git(["rev-parse", "HEAD"], explicit.path), f.git(["rev-parse", "main"]));
    f.git(["checkout", "--detach"], a.path);
    const detached = f.create("detached", a.path);
    assert.equal(f.git(["rev-parse", "HEAD"], detached.path), base);
  } finally { f.close(); }
});

test("info and remove resolve an external slash-named branch from a linked subdirectory", () => {
  const f = fixture();
  try {
    const external = join(f.root, "external path\nwith newline");
    f.git(["worktree", "add", "-q", external, "-b", "fix/dashboard-live-query"]);
    f.git(["commit", "--allow-empty", "-qm", "unmerged"], external);
    f.git(["branch", "upstream", "fix/dashboard-live-query"]);
    f.git(["branch", "--set-upstream-to=upstream", "fix/dashboard-live-query"]);
    const other = f.create("other");
    const cwd = join(other.path, "nested");
    mkdirSync(cwd);
    const info = f.run(["info", "fix/dashboard-live-query"], cwd);
    assert.equal(info.status, 0, info.stderr + info.stdout);
    assert.ok(info.stdout.includes(external));
    const completion = spawnSync("bash", ["-c", 'source "$1"; COMP_WORDS=(pi-worktree remove fix/); COMP_CWORD=2; _pi_worktree; printf "%s\\n" "${COMPREPLY[@]}"', "bash", join(import.meta.dirname, "../bin/pi-worktree-completion.bash")], { cwd, encoding: "utf8" });
    assert.equal(completion.stdout.trim(), "fix/dashboard-live-query");
    const refused = f.run(["remove", "fix/dashboard-live-query"], cwd, "n\n");
    assert.notEqual(refused.status, 0);
    assert.equal(existsSync(external), true);
    const removed = f.run(["remove", "fix/dashboard-live-query"], cwd, "y\n");
    assert.equal(removed.status, 0, removed.stderr + removed.stdout);
    assert.match(removed.stdout, /not merged into main; confirmed/);
    assert.equal(existsSync(external), false);
    assert.ok(!f.git(["branch", "--list", "fix/dashboard-live-query"]));
    assert.ok(existsSync(other.path));
  } finally { f.close(); }
});

test("submodule removal retains dirty-file confirmation before Git's required force", () => {
  const f = fixture();
  try {
    const library = join(f.root, "library");
    f.git(["init", "-q", library]);
    f.git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "library"], library);
    f.git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "modules/library"]);
    f.git(["commit", "-qam", "submodule"]);
    const a = f.create("submodule-clean");
    f.git(["-c", "protocol.file.allow=always", "submodule", "update", "--init"], a.path);
    const clean = f.run(["remove", "submodule-clean"]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(existsSync(a.path), false);
    const b = f.create("submodule-dirty");
    f.git(["-c", "protocol.file.allow=always", "submodule", "update", "--init"], b.path);
    const file = join(b.path, "modules/library/untracked");
    writeFileSync(file, "keep");
    assert.notEqual(f.run(["remove", "submodule-dirty"], f.repo, "n\n").status, 0);
    assert.equal(readFileSync(file, "utf8"), "keep");
    assert.equal(f.run(["remove", "submodule-dirty"], f.repo, "y\n").status, 0);
  } finally { f.close(); }
});

test("remove protects current, main, locked and dirty worktrees and only removes selected stale registrations", () => {
  const f = fixture();
  try {
    const a = f.create("A");
    for (const [name, cwd] of [["main", a.path], ["A", a.path]]) {
      const result = f.run(["remove", name], cwd, "y\ny\n");
      assert.notEqual(result.status, 0);
      assert.ok(existsSync(a.path));
      assert.ok(existsSync(f.repo));
    }
    f.git(["worktree", "lock", a.path]);
    assert.notEqual(f.run(["remove", "A"], f.repo, "y\ny\n").status, 0);
    f.git(["worktree", "unlock", a.path]);
    writeFileSync(join(a.path, "dirty"), "keep");
    assert.notEqual(f.run(["remove", "A"]).status, 0, "EOF must not authorize discarding files");
    assert.notEqual(f.run(["remove", "A"], f.repo, "n\n").status, 0);
    assert.equal(readFileSync(join(a.path, "dirty"), "utf8"), "keep");
    const stale = f.create("stale");
    const unrelated = f.create("unrelated");
    rmSync(stale.path, { recursive: true });
    rmSync(unrelated.path, { recursive: true });
    const result = f.run(["remove", "stale"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!f.git(["branch", "--list", "stale"]));
    assert.ok(f.git(["worktree", "list", "--porcelain"]).includes(unrelated.path));
    f.git(["branch", "branch-only"]);
    assert.equal(f.run(["remove", "branch-only"]).status, 0);
  } finally { f.close(); }
});

test("removing a detached managed checkout confirms commits not merged into main", () => {
  const f = fixture();
  try {
    const a = f.create("detached");
    f.git(["checkout", "--detach"], a.path);
    f.git(["commit", "--allow-empty", "-qm", "detached commit"], a.path);
    assert.notEqual(f.run(["remove", "detached"], f.repo, "n\n").status, 0);
    assert.ok(existsSync(a.path));
    assert.equal(f.run(["remove", "detached"], f.repo, "y\n").status, 0);
    assert.equal(existsSync(a.path), false);
    assert.ok(f.git(["branch", "--list", "detached"]), "a detached checkout does not own the old branch");
  } finally { f.close(); }
});

test("remove --force skips dirty and unmerged confirmations but retains protected-checkout guards", () => {
  const f = fixture();
  try {
    const a = f.create("force-dirty");
    f.git(["commit", "--allow-empty", "-qm", "unmerged"], a.path);
    writeFileSync(join(a.path, "dirty"), "explicitly discarded");
    const b = f.create("force-next");
    const removed = f.run(["remove", "--force", "force-dirty", "force-next"]);
    assert.equal(removed.status, 0, removed.stderr + removed.stdout);
    assert.equal(existsSync(a.path), false);
    assert.equal(existsSync(b.path), false);
    assert.ok(!f.git(["branch", "--list", "force-dirty", "force-next"]));
    const branchOnly = f.create("branch-only");
    f.git(["commit", "--allow-empty", "-qm", "unmerged branch"], branchOnly.path);
    f.git(["worktree", "remove", branchOnly.path]);
    assert.notEqual(f.run(["remove", "branch-only"]).status, 0);
    assert.ok(f.git(["branch", "--list", "branch-only"]));
    assert.equal(f.run(["rm", "branch-only", "-f"]).status, 0);
    assert.ok(!f.git(["branch", "--list", "branch-only"]));
    assert.doesNotMatch(removed.stdout, /\[y\/N\]/);
    const guard = f.create("guard");
    for (const [name, cwd] of [["main", guard.path], ["guard", guard.path]]) {
      assert.notEqual(f.run(["remove", "--force", name], cwd).status, 0);
      assert.ok(existsSync(guard.path));
    }
    f.git(["worktree", "lock", guard.path]);
    assert.notEqual(f.run(["remove", "--force", "guard"]).status, 0);
    assert.ok(existsSync(guard.path));
    const later = f.create("later");
    assert.notEqual(f.run(["remove", "--force", "guard", "later"]).status, 0);
    assert.ok(existsSync(later.path), "a force batch still stops at a protected target");
    for (const args of [["remove", "--force"], ["remove", "--unknown", "guard"]]) {
      assert.notEqual(f.run(args).status, 0);
    }
  } finally { f.close(); }
});
