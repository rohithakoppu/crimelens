"""Auth login: bounded network-failure handling.

Previously, a DNS/connection failure reaching Firebase's Identity Toolkit
during /auth/login was unhandled -- it either surfaced as a bare 500 with no
diagnosis, or hung indefinitely (well past requests' own connect timeout,
since that timeout doesn't bound DNS resolution). Both looked to a user like
"login doesn't work" for whichever account they happened to test with, with
no indication it was a network problem rather than bad credentials or a
broken account. This is a pure unit test -- no live network calls.
"""
import time

import pytest
import requests
from fastapi import HTTPException

import api.auth as auth_module


class _TinySettings:
    firebase_web_api_key = "test-key"


def test_login_returns_503_on_connection_failure(monkeypatch):
    monkeypatch.setattr(auth_module, "get_settings", lambda: _TinySettings())

    def _raise_connection_error(*args, **kwargs):
        raise requests.exceptions.ConnectionError("simulated DNS/connect failure")

    monkeypatch.setattr(requests, "post", _raise_connection_error)

    with pytest.raises(HTTPException) as exc_info:
        auth_module.login(auth_module.LoginRequest(email="x@example.com", password="whatever"))

    assert exc_info.value.status_code == 503
    assert "Authentication service unavailable" in exc_info.value.detail


def test_login_returns_503_within_bounded_time_when_call_never_returns(monkeypatch):
    """Simulates a stalled DNS resolver: the underlying call never returns
    or raises on its own. The endpoint must still fail fast via the hard
    executor deadline, not hang indefinitely."""
    monkeypatch.setattr(auth_module, "get_settings", lambda: _TinySettings())
    monkeypatch.setattr(auth_module, "_LOGIN_NETWORK_DEADLINE_SECONDS", 1)

    def _hang_forever(*args, **kwargs):
        time.sleep(30)

    monkeypatch.setattr(requests, "post", _hang_forever)

    started = time.monotonic()
    with pytest.raises(HTTPException) as exc_info:
        auth_module.login(auth_module.LoginRequest(email="x@example.com", password="whatever"))
    elapsed = time.monotonic() - started

    assert exc_info.value.status_code == 503
    assert elapsed < 5, f"login() should fail fast via the hard deadline, took {elapsed:.1f}s"
