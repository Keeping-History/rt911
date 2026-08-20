from video_grabber.directus.writer import wasabi_public_url


def test_encodes_spaces():
    assert wasabi_public_url("audio/AA77/0812 aa77 taxi.mp3") == (
        "https://files.911realtime.org/audio/AA77/0812%20aa77%20taxi.mp3"
    )


def test_keeps_path_separators_unencoded():
    assert "/audio/AA77/" in wasabi_public_url("audio/AA77/x.mp3")


def test_matches_the_form_directus_actually_stores():
    # The exact row that never linked for 18 months.
    assert wasabi_public_url("audio/AA77/0812 aa77 taxi to runway t.mp3") == (
        "https://files.911realtime.org/audio/AA77/"
        "0812%20aa77%20taxi%20to%20runway%20t.mp3"
    )


def test_space_free_keys_are_unchanged():
    # The three folders that DID link must keep linking.
    assert wasabi_public_url("audio/norad/neads/DRM1_DAT2_Channel_3_MCC_TK.mp3") == (
        "https://files.911realtime.org/audio/norad/neads/DRM1_DAT2_Channel_3_MCC_TK.mp3"
    )
