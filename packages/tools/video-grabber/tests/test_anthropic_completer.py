"""The completer must not hand back an empty string when a call was truncated.

Returning "" is indistinguishable from "the model had nothing to say", and both
callers degrade quietly on it: the summarizer falls back to mechanical
condensation, and party identification logs "did not return JSON" and moves on.
Neither names the real cause, which is a max_tokens budget consumed entirely by
thinking on a model that thinks by default.
"""
import sys
import types

import pytest

from video_grabber.config import Config
from video_grabber.transcript.summarize_flows import DEFAULT_MAX_TOKENS, anthropic_completer


class _Block:
    def __init__(self, type_, text=""):
        self.type = type_
        self.text = text


class _Msg:
    def __init__(self, content, stop_reason):
        self.content = content
        self.stop_reason = stop_reason


def _install_fake_anthropic(monkeypatch, msg):
    """Stand in for the SDK so no key or network is needed."""
    captured = {}

    class _Messages:
        def create(self, **kwargs):
            captured.update(kwargs)
            return msg

    class _Client:
        def __init__(self, api_key=None):
            self.messages = _Messages()

    monkeypatch.setitem(
        sys.modules, "anthropic", types.SimpleNamespace(Anthropic=_Client)
    )
    return captured


def test_truncated_with_no_text_names_the_token_budget(monkeypatch):
    msg = _Msg([_Block("thinking")], "max_tokens")
    _install_fake_anthropic(monkeypatch, msg)

    complete = anthropic_completer(Config(), model="claude-sonnet-5", max_tokens=1200)
    with pytest.raises(ValueError) as exc:
        complete("sys", "user")

    said = str(exc.value)
    assert "max_tokens=1200" in said
    assert "thinking" in said
    assert "claude-sonnet-5" in said


def test_normal_reply_passes_through(monkeypatch):
    msg = _Msg([_Block("thinking"), _Block("text", '{"ok":true}')], "end_turn")
    captured = _install_fake_anthropic(monkeypatch, msg)

    complete = anthropic_completer(Config(), model="claude-sonnet-5")
    assert complete("sys", "user") == '{"ok":true}'
    assert captured["max_tokens"] == DEFAULT_MAX_TOKENS


def test_a_model_with_genuinely_nothing_to_say_is_not_an_error(monkeypatch):
    # end_turn with empty text is a real (if odd) answer, not a truncation. Only
    # stop_reason=max_tokens means the budget was the problem.
    msg = _Msg([_Block("text", "")], "end_turn")
    _install_fake_anthropic(monkeypatch, msg)

    complete = anthropic_completer(Config(), model="claude-haiku-4-5")
    assert complete("sys", "user") == ""


def test_default_budget_leaves_room_for_thinking():
    # A ceiling, not a reservation: billing follows tokens actually emitted, so
    # this costs nothing on a non-thinking model and rescues a thinking one.
    assert DEFAULT_MAX_TOKENS >= 4000
