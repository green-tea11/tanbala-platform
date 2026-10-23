import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_port25.py"
spec = importlib.util.spec_from_file_location("check_port25", SCRIPT)
check_port25 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_port25)


class FakeSocket:
    def __init__(self, banner: bytes):
        self.banner = banner

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def recv(self, size: int) -> bytes:
        return self.banner

    def sendall(self, data: bytes) -> None:
        pass


def test_probe_open_when_banner_is_220():
    result = check_port25.probe("mx", connect=lambda *a, **k: FakeSocket(b"220 mx.google.com ESMTP\r\n"))

    assert result.is_open


def test_probe_closed_on_timeout():
    def timeout(*args, **kwargs):
        raise TimeoutError("timed out")

    result = check_port25.probe("mx", connect=timeout)

    assert not result.is_open
    assert "TimeoutError" in result.detail


def test_probe_closed_without_220():
    result = check_port25.probe("mx", connect=lambda *a, **k: FakeSocket(b"554 blocked\r\n"))

    assert not result.is_open
