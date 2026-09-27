import os, pty, sys, time, select
H, P, prompt = sys.argv[1], sys.argv[2], sys.argv[3]
wait = float(sys.argv[4]) if len(sys.argv) > 4 else 60
pid, fd = pty.fork()
if pid == 0:
    os.chdir(P); os.environ["HOME"] = H; os.environ["TERM"] = "xterm-256color"
    os.execvp("cursor-agent", ["cursor-agent", "--force", "--approve-mcps", "--model", "auto", prompt])
import fcntl, termios, struct
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 200, 0, 0))
out = b""; end = time.time() + wait
def pump(t):
    global out
    e = time.time() + t
    while time.time() < e:
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try: out += os.read(fd, 65536)
            except OSError: return
pump(wait)
for extra in sys.argv[5:]:
    os.write(fd, extra.encode()); pump(2); os.write(fd, b"\r"); pump(float(os.environ.get("STEP_WAIT", "40")))
os.write(fd, b"\x03"); pump(2); os.write(fd, b"\x03"); pump(3)
try: os.kill(pid, 9)
except Exception: pass
open(os.path.join(H, "interactive.log"), "ab").write(out)
