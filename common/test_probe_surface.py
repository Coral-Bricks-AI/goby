from common.probe_surface import bucket_1, bucket_60


def test_bucket_1():
    assert bucket_1([0, 1, 1+1]) == 2


def test_bucket_60():
    assert bucket_60([0, 60, 60+1]) == 2

