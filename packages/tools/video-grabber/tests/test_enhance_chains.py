import pytest

from video_grabber.enhance.chains import CHAINS, audition_key, enhanced_key


def test_enhanced_key_mirrors_the_audio_path_under_the_new_prefix():
    assert enhanced_key("audio/AA77/0812 aa77 taxi.mp3") == \
        "audio-enhanced/AA77/0812 aa77 taxi.mp3"


def test_enhanced_key_refuses_anything_outside_audio():
    # Guards against ever writing an "enhanced" file over a source recording.
    with pytest.raises(ValueError):
        enhanced_key("subtitles/audio/x.srt")


def test_enhanced_key_refuses_an_already_enhanced_key():
    # Re-running must not produce audio-enhanced/audio-enhanced/...
    with pytest.raises(ValueError):
        enhanced_key("audio-enhanced/AA77/x.mp3")


def test_enhanced_key_is_never_the_input_key():
    k = "audio/norad/neads/DRM1_DAT2_Channel_3_MCC_TK.mp3"
    assert enhanced_key(k) != k


def test_audition_keys_are_namespaced_per_chain():
    a = audition_key("audio/AA77/x.mp3", "dfn_moderate")
    b = audition_key("audio/AA77/x.mp3", "dfn_full")
    assert a != b
    assert a.startswith("audio-enhanced/_audition/")


def test_audition_key_rejects_an_unknown_chain():
    with pytest.raises(ValueError, match="unknown chain"):
        audition_key("audio/AA77/x.mp3", "magic_restore")


def test_every_chain_declares_whether_it_uses_a_model():
    for name, chain in CHAINS.items():
        assert isinstance(chain.uses_model, bool), name


def test_no_chain_is_generative():
    # Hard constraint: generative enhancement can emit speech nobody said, and
    # its failure mode is invisible to every quality signal we would use.
    for name, chain in CHAINS.items():
        assert not chain.generative, f"{name} is generative and must not exist here"


def test_at_least_one_chain_is_model_free_so_the_audition_has_a_control():
    assert any(not c.uses_model for c in CHAINS.values())
