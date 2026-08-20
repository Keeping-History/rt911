# Mac Studio transcribe workers

The Mac Studio (M1 Max) runs native whisper.cpp/Metal workers that claim from the same
`transcribe_jobs` queue as the cluster, reached over a reverse SSH tunnel. It is several
times faster than the CPU-only cluster pod, so in practice it does the transcription and
the cluster is configured not to claim at all (`TRANSCRIBE_DISPATCH_LIMIT=0`).

These files exist because the Mac's configuration used to live **only on that machine**.
That is how it came to run five-week-stale code against production (issue #379) and to
sit throttled for weeks (issue #389). Provision from here, not by hand.

## Layout on the Mac

```
~/transcribe/
  rt911/                  sparse git checkout (packages/tools/video-grabber only)
  video-grabber -> rt911/packages/tools/video-grabber   symlink; the venv installs this
  venv/                   python 3.12, `pip install -e ./video-grabber`
  whisper.cpp/            Metal build + ggml-medium.en.bin + ggml-silero-v5.1.2.bin
  worker.env              mode 600, production credentials — NOT in this repo
  run-worker.sh           one worker slot
  logs/
```

## Two settings that are not obvious and cost real time

**`ProcessType` must be `Standard`.** The plists originally said `Background`, which macOS
throttles across CPU, I/O and GPU. That was survivable until whisper gained `--vad`: VAD
loads a second model and takes an ANE/CoreML path that stalls outright when throttled. The
failure is not slowness but a hang — the worker stays alive, heartbeats its claimed job,
and never finishes it, so the supervisor cannot reclaim the row either. One throttled
worker permanently removes a job from the queue. Throughput was **6 files/hour throttled,
108 not**.

`dispatch_worker` now asserts this at startup and exits rather than run throttled
(`ALLOW_THROTTLED_WORKER=1` overrides). To reproduce the condition deliberately:
`taskpolicy -b python3 -c '...'` — see `video_grabber/transcribe/qos.py`.

**Run 2 workers, not 5.** Concurrent whisper processes on this machine collapse. Measured
per 10-minute window:

| workers | wall | throughput |
|---|---:|---|
| 1 | 38 s | 1.57 win/min |
| 2 | 64 s | **1.87 win/min** |
| 3 | 94 s | 1.91 win/min |
| 5 | never finished | — |

The step from 3 to 5 is a hang, not gradual degradation, so 2 trades 2% of throughput for
a real safety margin. Workers 3–5 should stay `launchctl disable`d.

## Install / update

```sh
# first time
git clone --filter=blob:none --sparse --depth 1 \
    https://github.com/Keeping-History/rt911.git ~/transcribe/rt911
git -C ~/transcribe/rt911 sparse-checkout set packages/tools/video-grabber
ln -s rt911/packages/tools/video-grabber ~/transcribe/video-grabber
~/transcribe/venv/bin/pip install -e ~/transcribe/video-grabber

# run-worker.sh must sit in ~/transcribe: it does `cd "$(dirname "$0")"` and then
# sources ./worker.env and runs ./venv, neither of which exist beside the repo copy.
cp ~/transcribe/video-grabber/mac/run-worker.sh ~/transcribe/run-worker.sh

# install the agents (N = 1..2)
for N in 1 2; do
  sed -e "s|__N__|$N|g" -e "s|__HOME__|$HOME|g" \
      ~/transcribe/video-grabber/mac/com.rt911.transcribe-worker.plist.template \
      > ~/Library/LaunchAgents/com.rt911.transcribe-worker-$N.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.rt911.transcribe-worker-$N.plist
done
```

`launchctl bootstrap` over SSH registers an agent but does not always start it despite
`RunAtLoad`; `launchctl kickstart gui/$(id -u)/<label>` forces it.

To update after a merge — **stop first**, because a running worker holds claims:

```sh
for N in 1 2; do launchctl bootout gui/$(id -u)/com.rt911.transcribe-worker-$N; done
git -C ~/transcribe/rt911 fetch --depth 1 origin main
git -C ~/transcribe/rt911 reset --hard origin/main
~/transcribe/venv/bin/pip install -q -e ~/transcribe/video-grabber
for N in 1 2; do launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.rt911.transcribe-worker-$N.plist; done
```

Requeue anything left mid-flight **while the workers are stopped**, never after — resetting
`transcribing` rows under a live claimer hands the same job to a second worker:

```sql
UPDATE transcribe_jobs SET stage = 'pending', error_message = NULL
 WHERE stage = 'transcribing';
```

## worker.env

Not committed — it holds production credentials. Required keys:

```sh
DATABASE_URL=postgresql+asyncpg://…@127.0.0.1:15432/video_grabber   # via the tunnel
DIRECTUS_URL=http://127.0.0.1:18055
DIRECTUS_API_TOKEN=…
WASABI_ENDPOINT_URL=https://s3.us-central-1.wasabisys.com
WASABI_BUCKET=files.911realtime.org
WASABI_ACCESS_KEY_ID=…
WASABI_SECRET_ACCESS_KEY=…
PREFECT_API_URL=http://127.0.0.1:14200/api
WHISPER_BIN=$HOME/transcribe/whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL=$HOME/transcribe/whisper.cpp/models/ggml-medium.en.bin
VAD_MODEL=$HOME/transcribe/whisper.cpp/models/ggml-silero-v5.1.2.bin
WHISPER_THREADS=8
SCRATCH_DIR=$HOME/transcribe/scratch
```

`VAD_MODEL` is required — `transcribe_windows` always passes `--vad`, and whisper-cli
fails without the model file. Fetch it with
`bash ./models/download-vad-model.sh silero-v5.1.2` from `~/transcribe/whisper.cpp`.
