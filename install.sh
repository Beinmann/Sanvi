#!/usr/bin/env sh
# Install Sanvi: puts `tk` and `sanvi` on your PATH as symlinks to this checkout.
# Usage: ./install.sh [--prefix DIR] [--uninstall]     (default prefix: ~/.local, links go to DIR/bin)
set -eu

prefix="${HOME}/.local"
uninstall=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) [ $# -ge 2 ] || { echo "--prefix needs a directory" >&2; exit 2; }; prefix="$2"; shift ;;
    --uninstall) uninstall=1 ;;
    -h|--help) sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

here="$(cd "$(dirname "$0")" && pwd -P)"
target="$here/bin/tk.js"
bindir="$prefix/bin"

if [ "$uninstall" = 1 ]; then
  for name in tk sanvi; do
    link="$bindir/$name"
    if [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ]; then rm "$link" && echo "removed $link"; fi
  done
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "Node.js 20 or newer is required (node not found)" >&2; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 20 ] || { echo "Node.js 20 or newer is required (found $(node -v))" >&2; exit 1; }
[ -f "$target" ] || { echo "cannot find $target" >&2; exit 1; }

chmod +x "$target"
mkdir -p "$bindir"
for name in tk sanvi; do
  link="$bindir/$name"
  if [ -e "$link" ] && [ ! -L "$link" ]; then echo "skipping $link: exists and is not a symlink" >&2; continue; fi
  ln -sf "$target" "$link"
  echo "linked $link -> $target"
done

case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "note: $bindir is not on your PATH; add it, e.g. export PATH=\"$bindir:\$PATH\"" ;;
esac
echo "done. Try: tk --dir /path/to/tickets serve"
