#!/usr/bin/env python3
"""Exercise a real Pi TUI through a PTY and an offline fixture provider.

BG_SMOKE_RENDER=1 relays the actual ANSI stream into an isolated terminal window.
BG_SMOKE_CAPTURE=1 captures only that named window (requires X11 + ImageMagick).
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import termios
import tty

import pexpect

PKG = Path(__file__).resolve().parents[1]
ROOT = PKG.parents[1]
OUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / '.cache/verification/background-tui'
OUT.mkdir(parents=True, exist_ok=True)
work = Path(tempfile.mkdtemp(prefix='pi-bg-tui-'))
events_path = work / 'events.jsonl'
render = os.environ.get('BG_SMOKE_RENDER') == '1'
capture = os.environ.get('BG_SMOKE_CAPTURE') == '1'
env = dict(os.environ, PI_CODING_AGENT_DIR=str(work), PI_OFFLINE='1', BG_SMOKE_EVENTS=str(events_path), TERM='xterm-256color', COLORTERM='truecolor')
env.pop('PI_HERDR_SUBAGENTS_CHILD', None)
(work / 'settings.json').write_text(json.dumps({'quietStartup': True}))
args = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-session', '--offline',
        '-e', 'builtin:codemode', '-e', str(PKG / 'extensions/background-tasks.ts'),
        '-e', str(ROOT / 'packages/scheduler/extensions/scheduler.ts'), '-e', str(PKG / 'tests/fixtures/provider.ts'),
        '--tools', 'codemode,background_task,schedule', '--model', 'bg-fixture/deterministic', '--tui-mode', 'fullscreen']
size = os.get_terminal_size(sys.stdout.fileno()) if render else os.terminal_size((140, 42))
terminal_settings = termios.tcgetattr(sys.stdin.fileno()) if render else None
if render:
    tty.setraw(sys.stdin.fileno())
child = pexpect.spawn(os.environ.get('PI_TEST_BINARY', shutil.which('pi')), args, cwd=str(work), env=env,
                      encoding='utf-8', codec_errors='replace', dimensions=(size.lines, size.columns), timeout=20)
child.linesep = '\r'
raw = ''
raw_file = (OUT / 'terminal.ansi').open('w')
screens = []


def pump(seconds=0.1):
    global raw
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            data = child.read_nonblocking(65536, timeout=min(0.05, max(0.001, deadline - time.monotonic())))
            raw += data
            raw_file.write(data)
            raw_file.flush()
            if render:
                sys.stdout.write(data)
                sys.stdout.flush()
        except pexpect.TIMEOUT:
            pass
        except pexpect.EOF:
            break


def events():
    if not events_path.exists():
        return []
    return [json.loads(line) for line in events_path.read_text().splitlines() if line]


def wait(check, label, timeout=20):
    deadline = time.monotonic() + timeout
    while not check():
        pump()
        if not child.isalive():
            raise AssertionError('Pi exited before ' + label)
        if time.monotonic() > deadline:
            raise AssertionError('Timeout waiting for ' + label + '\n' + raw[-4000:])
    pump(0.15)


def send(text):
    child.sendline(text)
    pump(0.1)


def tools(name='background_task'):
    return [e for e in events() if e.get('event') == 'tool_end' and e.get('name') == name]


def finished(status):
    return [e for e in events() if e.get('event') == 'custom' and e.get('type') == 'background-task-finished'
            and e.get('details', {}).get('task', {}).get('status') == status]


def shot(name):
    pump(0.2)
    if capture:
        info = subprocess.check_output(['xwininfo', '-name', 'π - ' + work.name], text=True)
        window = next(line.split()[3] for line in info.splitlines() if 'Window id:' in line)
        path = OUT / (name + '.png')
        subprocess.run(['import', '-window', window, str(path)], check=True)
        screens.append(str(path))


def alive(pid):
    try:
        os.kill(pid, 0)
        stat = Path(f'/proc/{pid}/stat')
        return not (stat.exists() and stat.read_text().split(') ', 1)[1].startswith('Z '))
    except ProcessLookupError:
        return False


def start_long():
    before = len(tools())
    send('SMOKE_LONG')
    wait(lambda: len(tools()) > before and (work / 'child.pid').exists(), 'lifecycle task')
    return [int((work / file).read_text()) for file in ['shell.pid', 'child.pid']]


try:
    wait(lambda: any(e.get('event') == 'loaded' for e in events()), 'extension startup')
    loaded = next(e for e in events() if e.get('event') == 'loaded')
    assert loaded['tools'].count('background_task') == 1
    send('/schedule add 1h Check release status')
    wait(lambda: 'active schedule' in raw, 'Scheduler widget')
    send('SMOKE_START')
    wait(lambda: len(tools()) >= 3 and any(e.get('name') == 'codemode' for e in tools('codemode')), 'Codemode startup batch')
    starts = tools()[:3]
    assert not starts[0]['isError'] and not starts[1]['isError'] and starts[2]['isError'], starts
    first = starts[0]['result']['structuredContent']['task']
    second = starts[1]['result']['structuredContent']['task']
    assert first['status'] == second['status'] == 'running'
    assert any('Script completed' in str(e.get('result')) for e in tools('codemode')), tools('codemode')
    assert not finished('succeeded'), 'Sleeping job must survive Codemode completion'
    shot('running')
    send('/bg output ' + first['id'])
    send('SMOKE_CANCEL')
    wait(lambda: bool(finished('cancelled')), 'cancel follow-up')
    wait(lambda: bool(finished('succeeded')), 'successful background follow-up')
    shot('completed')
    send('SMOKE_OUTPUT')
    wait(lambda: any(e.get('result', {}).get('structuredContent', {}).get('output') == 'BUILD SUCCESSFUL\n' for e in tools()), 'explicit output query')
    wait(lambda: 'BACKGROUND_FOLLOWUP_RECEIVED' in raw, 'main agent automatic response')
    pump(5.3)
    shot('history')

    pids = start_long()
    loaded_count = len([e for e in events() if e.get('event') == 'loaded'])
    send('/reload')
    wait(lambda: len([e for e in events() if e.get('event') == 'loaded']) > loaded_count, 'reload')
    wait(lambda: all(not alive(pid) for pid in pids), 'reload process cleanup')
    (work / 'child.pid').unlink(missing_ok=True)
    pids = start_long()
    send('/new')
    wait(lambda: all(not alive(pid) for pid in pids), 'new-session process cleanup')
    (work / 'child.pid').unlink(missing_ok=True)
    pids = start_long()
    child.sendcontrol('d')
    pump(0.15)
    if child.isalive():
        child.sendcontrol('d')
    deadline = time.monotonic() + 10
    while child.isalive() and time.monotonic() < deadline:
        pump()
    assert not child.isalive(), 'Pi did not exit cleanly'
    assert all(not alive(pid) for pid in pids), 'Quit leaked a shell or child process'
    records = events()
    logs = [e['result']['structuredContent']['task']['log_path'] for e in tools()
            if e.get('result', {}).get('structuredContent', {}).get('task')]
    assert all(not Path(path).exists() for path in logs), 'Session logs were not removed'
    (OUT / 'events.jsonl').write_text('\n'.join(json.dumps(e) for e in records) + '\n')
    (OUT / 'result.json').write_text(json.dumps({'passed': True, 'screenshots': screens,
        'checks': ['two jobs', 'third rejected', 'Codemode returns while jobs live', 'Scheduler coexistence', '/bg output',
                   'cancel notification', 'success notification', 'main agent follow-up', '5-second terminal row', 'reload cleanup', 'new-session cleanup', 'quit cleanup']}, indent=2))
except Exception:
    (OUT / 'error.txt').write_text(traceback.format_exc())
    raise
finally:
    if child.isalive():
        child.sendcontrol('d')
        pump(0.1)
        if child.isalive():
            child.sendcontrol('d')
            pump(0.5)
        if child.isalive():
            child.terminate(force=True)
    raw_file.close()
    if terminal_settings is not None:
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, terminal_settings)
    if events_path.exists() and not (OUT / 'events.jsonl').exists():
        shutil.copyfile(events_path, OUT / 'events.jsonl')
    shutil.rmtree(work)
