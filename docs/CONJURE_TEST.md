# Conjure test helpers

The self-contained remote page is in `tests/conjure-test.html`. It makes no network requests, blocks external content with CSP, and reports keydown values, FPS, and keydown-to-next-frame time. That browser-side timing does not measure the physical remote's total latency.

The guarded launcher `tests/conjure-launch-test.py`:

1. Serves the test page from the controller's LAN address on port 8765.
2. Reads the private paired token without displaying it.
3. Sends one authenticated app ID 17 / namespace 4 Conjure launch request.
4. Serves for up to 180 seconds, then checks the current app and restores Vizio Home only if app ID 17 remains active.

No TV request is sent unless `--approved-launch` is present. Press Home as a fallback. Configure the TV and auth file through `.env` or `--tv` and `--auth-file`; configure the server address with `--host-ip`.

```sh
python3 tests/conjure-launch-test.py --approved-launch
```

The owner previously confirmed the test page registered all directions, OK, and Back, and that Home exited the page. Numeric FPS and latency values were not retained.

## A/B page test

`tests/horizon-launch-test.py` selects the minimal remote page (A) or full Horizon (B). Both use the same Conjure runtime. It is gated by `--approved-launch` and checks the current app before attempting Home restoration.

```sh
python3 tests/horizon-launch-test.py --mode minimal --approved-launch
python3 tests/horizon-launch-test.py --mode horizon --approved-launch
```

The optimized Horizon A/B test was reported responsive with no noticeable lag. Older files before the latency optimization are retained under `tests/rollback/pre-latency-optimization/`.
