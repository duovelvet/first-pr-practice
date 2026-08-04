import pytest

from greet import greet


def test_greet_returns_expected_message():
    assert greet("world") == "Hello, world!"


def test_greet_raises_on_empty_name():
    with pytest.raises(ValueError):
        greet("")
