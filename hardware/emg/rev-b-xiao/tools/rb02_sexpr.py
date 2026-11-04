"""Minimal KiCad s-expression reader/writer that preserves which atoms were quoted (used by rb02_build_pcb.py)."""
import re


class Q(str):
    """a quoted string atom"""


_TOK = re.compile(r'\(|\)|"(?:\\.|[^"\\])*"|[^\s()"]+')


def parse(text):
    stack = [[]]
    for m in _TOK.finditer(text):
        t = m.group(0)
        if t == "(":
            stack.append([])
        elif t == ")":
            x = stack.pop()
            stack[-1].append(x)
        elif t[0] == '"':
            stack[-1].append(Q(t[1:-1].replace('\\"', '"').replace("\\\\", "\\")))
        else:
            stack[-1].append(t)
    return stack[0][0]


def kids(node, name):
    return [c for c in node if isinstance(c, list) and c and c[0] == name]


def first(node, name, default=None):
    k = kids(node, name)
    return k[0] if k else default


def _atom(a):
    if isinstance(a, Q):
        return '"' + str(a).replace("\\", "\\\\").replace('"', '\\"') + '"'
    if isinstance(a, float):
        s = f"{a:.6f}".rstrip("0").rstrip(".")
        return "0" if s in ("-0", "") else s
    return str(a)


def dump(node, lvl=0):
    ind = "\t" * lvl
    if not isinstance(node, list):
        return ind + _atom(node)
    head = [x for x in node if not isinstance(x, list)]
    subs = [x for x in node if isinstance(x, list)]
    # leading atoms inline, then children on their own lines
    out = ind + "(" + " ".join(_atom(x) for x in node[: len(head)] if not isinstance(x, list))
    # keep order: atoms may also appear after lists (rare); emit generically
    out = ind + "("
    first_line = True
    parts = []
    inline = []
    for x in node:
        if isinstance(x, list):
            break
        inline.append(_atom(x))
    rest = node[len(inline):]
    out += " ".join(inline)
    if not rest:
        return out + ")"
    # short all-atom children collapse onto one line
    if all(isinstance(r, list) and all(not isinstance(y, list) for y in r) for r in rest) and len(rest) <= 3 and sum(len(" ".join(_atom(y) for y in r)) for r in rest) < 60 and lvl > 0 and node[0] in ("at", "size", "xy", "pts"):
        return out + " " + " ".join("(" + " ".join(_atom(y) for y in r) + ")" for r in rest) + ")"
    lines = [out]
    for r in rest:
        if isinstance(r, list):
            lines.append(dump(r, lvl + 1))
        else:
            lines.append("\t" * (lvl + 1) + _atom(r))
    lines.append(ind + ")")
    return "\n".join(lines)
