"""Strategy packs: folders of Python strategies loaded at run time.

A pack is any directory. Every top-level module (`*.py`) or package (folder
with `__init__.py`) in it is imported, and each `Strategy` subclass defined
there becomes available as `<pack>/<module>:<Class>`. The pack name is the
folder name. Packs are configured with PSR_STRATEGY_PACKS (paths separated by
the OS path separator); the open example pack ships with the service.

Private packs stay outside the public repository: only their path is configured.
"""

from hashlib import sha256
import importlib
import importlib.util
from pathlib import Path
import re
import sys
import types

from .api import Strategy, describe_strategy

NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
ROOT = "psr_packs"
BUILTIN_PACK = Path(__file__).resolve().parent.parent / "strategies"


def pack_dirs(paths):
    result = {}
    for raw in [BUILTIN_PACK, *(paths or [])]:
        path = Path(raw).expanduser().resolve()
        if not path.is_dir():
            raise ValueError(f"strategy pack is not a directory: {raw}")
        name = path.name if path != BUILTIN_PACK else "examples"
        if not NAME_RE.fullmatch(name):
            raise ValueError(f"strategy pack folder name must be a Python identifier: {path.name}")
        if name in result and result[name] != path:
            raise ValueError(f"two strategy packs are named {name}")
        result[name] = path
    return result


def pack_hash(path):
    """Content hash of every Python file in a pack (pinned in the run manifest)."""
    digest = sha256()
    for file in sorted(Path(path).rglob("*.py")):
        if "__pycache__" in file.parts:
            continue
        digest.update(str(file.relative_to(path)).encode())
        digest.update(b"\0")
        digest.update(file.read_bytes())
    return digest.hexdigest()


def _package(name, path):
    if ROOT not in sys.modules:
        root = types.ModuleType(ROOT)
        root.__path__ = []
        sys.modules[ROOT] = root
    full = f"{ROOT}.{name}"
    module = sys.modules.get(full)
    if module is None:
        module = types.ModuleType(full)
        module.__path__ = [str(path)]
        sys.modules[full] = module
    return full


def _modules(path):
    for item in sorted(Path(path).iterdir()):
        if item.name.startswith(("_", ".")):
            continue
        if item.suffix == ".py" and NAME_RE.fullmatch(item.stem):
            yield item.stem
        elif item.is_dir() and (item / "__init__.py").exists() and NAME_RE.fullmatch(item.name):
            yield item.name


def _strategies(module):
    for value in vars(module).values():
        if isinstance(value, type) and issubclass(value, Strategy) and value is not Strategy \
                and value.__module__ == module.__name__:
            yield value


def discover(paths=None):
    """All strategies of all packs, with metadata for the UI. Broken modules are reported, not fatal."""
    rows, errors = [], []
    for name, path in pack_dirs(paths).items():
        package = _package(name, path)
        digest = pack_hash(path)
        for module_name in _modules(path):
            try:
                module = importlib.import_module(f"{package}.{module_name}")
                for cls in _strategies(module):
                    rows.append({"id": f"{name}/{module_name}:{cls.__name__}", "pack": name,
                                 "builtin": path == BUILTIN_PACK, "packSha256": digest, **describe_strategy(cls)})
            except Exception as exc:  # noqa: BLE001 - surface any import problem to the user
                errors.append({"pack": name, "module": module_name, "error": f"{type(exc).__name__}: {exc}"[:500]})
    return rows, errors


def load_strategy(ref, paths=None):
    """Import `<pack>/<module>:<Class>`; returns (class, pack content hash)."""
    match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)/([A-Za-z_][A-Za-z0-9_]*):([A-Za-z_][A-Za-z0-9_]*)", ref or "")
    if not match:
        raise ValueError("strategy reference must look like pack/module:Class")
    pack, module_name, class_name = match.groups()
    packs = pack_dirs(paths)
    if pack not in packs:
        raise ValueError(f"strategy pack {pack} is not configured")
    module = importlib.import_module(f"{_package(pack, packs[pack])}.{module_name}")
    cls = getattr(module, class_name, None)
    describe_strategy(cls)
    return cls, pack_hash(packs[pack])
