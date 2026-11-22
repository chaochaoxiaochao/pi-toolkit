"""Run the baseline under an isolated Herdr server with an 80x24 PTY."""
import fcntl, json, os, pty, select, signal, struct, subprocess, sys, tempfile, termios, threading, time
from pathlib import Path

binary, package, evidence = map(os.path.abspath, sys.argv[1:4])
smoke = str(Path(__file__).with_name("smoke.mjs").absolute())
zsh = "/bin/zsh" if os.path.exists("/bin/zsh") else "/usr/bin/zsh"
with tempfile.TemporaryDirectory(prefix="pi32-", dir="/tmp") as tmp:
    root = Path(tmp)
    for name in ("home", "config/herdr", "runtime", "state", "cache", "workspace", "pi-agent"):
        (root / name).mkdir(parents=True, exist_ok=True)
    (root / "config/herdr/config.toml").write_text(
        f'onboarding = false\n[terminal]\ndefault_shell = "{zsh}"\nshell_mode = "non_login"\n'
    )
    env = {
        **{k: v for k, v in os.environ.items() if k in {"PATH", "LANG", "LC_ALL", "ISSUE32_ROUNDS"}},
        "HOME": str(root / "home"),
        "XDG_CONFIG_HOME": str(root / "config"),
        "XDG_RUNTIME_DIR": str(root / "runtime"),
        "XDG_STATE_HOME": str(root / "state"),
        "XDG_CACHE_HOME": str(root / "cache"),
        "PI_CODING_AGENT_DIR": str(root / "pi-agent"),
        "PI_HERDR_SUBAGENTS_HERDR_BINARY": binary,
        "HERDR_SOCKET_PATH": str(root / "herdr.sock"),
        "TERM": "xterm-256color",
        "SHELL": zsh,
        "NO_PROXY": "127.0.0.1,localhost",
    }
    pid, master = pty.fork()
    if not pid:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        os.chdir(root / "workspace")
        os.execve(binary, [binary, "server"], env)
    stop = threading.Event()
    pty_tail = bytearray()
    def drain():
        while not stop.is_set():
            try:
                if select.select([master], [], [], 0.2)[0]:
                    data = os.read(master, 65536)
                    if not data:
                        return
                    pty_tail.extend(data)
                    del pty_tail[:-1500]
            except OSError:
                return
    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    def cli(*args):
        return json.loads(subprocess.check_output([binary, *args], env=env, text=True, stderr=subprocess.DEVNULL, timeout=2))["result"]
    try:
        workspace = pane = None
        last_error = None
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                workspaces = cli("workspace", "list")["workspaces"]
                if not workspaces:
                    cli("workspace", "create", "--cwd", str(root / "workspace"), "--label", "issue32", "--focus")
                else:
                    workspace = next((w for w in workspaces if w.get("focused")), workspaces[0])["workspace_id"]
                    panes = cli("pane", "list", "--workspace", workspace)["panes"]
                    if panes:
                        pane = next((p for p in panes if p.get("focused")), panes[0])["pane_id"]
                        break
            except (OSError, subprocess.SubprocessError, KeyError, ValueError) as err:
                last_error = type(err).__name__
            time.sleep(0.1)
        if not workspace or not pane:
            print("Herdr bootstrap PTY tail:", repr(bytes(pty_tail)), file=sys.stderr)
            Path(evidence).write_text(json.dumps([{"event": "herdr-bootstrap-failed", "lastCliErrorType": last_error}]))
            raise RuntimeError("Herdr did not expose an initial workspace and pane")
        env.update(HERDR_ENV="1", HERDR_WORKSPACE_ID=workspace, HERDR_PANE_ID=pane)
        result = subprocess.run(
            ["node", "--experimental-strip-types", smoke, package, str(root / "workspace"), evidence, str(root / "pi-agent")],
            env=env, timeout=165, check=False,
        )
        sys.exit(result.returncode)
    finally:
        stop.set()
        reader.join(1)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(25):
            if os.waitpid(pid, os.WNOHANG)[0]:
                break
            time.sleep(0.1)
        else:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        os.close(master)
