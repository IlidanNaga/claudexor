"""Offline test driver: a real controlling terminal for the built CLI (POSIX only)."""
import errno
import json
import os
import pty
import select
import signal
import sys

pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
print(json.dumps({"pid": pid}), file=sys.stderr, flush=True)
watch = [master, sys.stdin.fileno()]
try:
    while True:
        readable, _, _ = select.select(watch, [], [], 0.05)
        for fd in readable:
            if fd == master:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if data:
                    os.write(sys.stdout.fileno(), data)
                else:
                    watch.remove(master)
                    os.close(master)
                    master = None
            else:
                line = sys.stdin.readline()
                if not line:
                    watch.remove(sys.stdin.fileno())
                    continue
                command = json.loads(line)
                if command["op"] == "close" and master is not None:
                    watch.remove(master)
                    os.close(master)
                    master = None
                elif command["op"] == "write" and master is not None:
                    os.write(master, command["data"].encode())
                elif command["op"] == "signal":
                    try:
                        os.kill(pid, getattr(signal, command["signal"]))
                    except ProcessLookupError:
                        pass
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            print(json.dumps({"exit": os.waitstatus_to_exitcode(status)}), file=sys.stderr, flush=True)
            break
finally:
    if master is not None:
        os.close(master)
