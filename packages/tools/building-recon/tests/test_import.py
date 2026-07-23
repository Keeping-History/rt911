def test_package_imports():
    import build_2001  # root pure module (py-modules)
    import building_recon  # package

    assert hasattr(build_2001, "__doc__")
