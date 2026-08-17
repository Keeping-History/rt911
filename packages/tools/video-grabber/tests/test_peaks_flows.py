from video_grabber.peaks.flows import should_compute


def test_skips_rows_that_already_have_peaks():
    assert should_compute({"peaks": [[0, 0]]}, force=False) is False


def test_computes_rows_with_no_peaks():
    assert should_compute({"peaks": None}, force=False) is True


def test_computes_rows_missing_the_key_entirely():
    assert should_compute({}, force=False) is True


def test_force_recomputes_everything():
    assert should_compute({"peaks": [[0, 0]]}, force=True) is True
