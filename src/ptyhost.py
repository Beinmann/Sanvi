# Runs a command on a pseudo-terminal and bridges it to this process's stdin/stdout (Node has no built-in pty).
# usage: ptyhost.py CWD COLS ROWS CMD [ARGS...]
# stdin -> terminal input, terminal output -> stdout, fd 3: resize requests, lines of "COLS ROWS".
# When stdin closes or this process is terminated, the command gets SIGHUP (then SIGKILL), so nothing is left behind.
import fcntl, os, pty, select, signal, struct, sys, termios, time

cwd, cols, rows, *cmd = sys.argv[1:]

def resize(fd, c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))

pid, master = pty.fork()
if pid == 0:
    try:
        os.chdir(cwd)
        os.execvp(cmd[0], cmd)
    except OSError as e:
        sys.stderr.write('cannot run %s: %s\r\n' % (cmd[0], e.strerror))
        os._exit(127)
resize(master, int(cols), int(rows))

def stop(*_):
    for sig in (signal.SIGHUP, signal.SIGKILL):
        try:
            os.killpg(pid, sig)
        except OSError:
            break
        for _ in range(20):
            if os.waitpid(pid, os.WNOHANG)[0]:
                os._exit(0)
            time.sleep(0.05)
    os._exit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGHUP, stop)
fds = {0: 'in', master: 'out'}
ctl = b''
try:
    os.fstat(3)
    fds[3] = 'ctl'
except OSError:
    pass
while True:
    ready, _, _ = select.select(list(fds), [], [], 1)
    for fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if fd == master:
            if not data:
                _, status = os.waitpid(pid, 0)
                os._exit(os.waitstatus_to_exitcode(status))
            os.write(1, data)
        elif fd == 0:
            if not data:
                stop()
            os.write(master, data)
        else:
            if not data:
                del fds[3]
                continue
            ctl += data
            while b'\n' in ctl:
                line, ctl = ctl.split(b'\n', 1)
                try:
                    c, r = line.split()
                    resize(master, int(c), int(r))
                except ValueError:
                    pass
