"""RB-03R: pcbnew rewrites .kicad_pro (and creates .history / lock files) when it opens a board that sits in a real project directory.
Every RB-03R tool that calls pcbnew passes its board path through safe_pcb(): a board inside rev-b-xiao/kicad/ is first copied, with
its project files, into a temporary directory and the copy is opened instead."""
import atexit
import shutil
import tempfile
from pathlib import Path

_KICAD = (Path(__file__).resolve().parent.parent / "kicad").resolve()


def safe_pcb(path):
    p = Path(path).resolve()
    try:
        p.relative_to(_KICAD)
    except ValueError:
        return p
    d = Path(tempfile.mkdtemp(prefix="rb03r_safe_"))
    atexit.register(shutil.rmtree, d, True)
    src = p.parent
    shutil.copytree(src, d / "prj", ignore=shutil.ignore_patterns(".history", "~*", "*.lck"))
    return d / "prj" / p.name
