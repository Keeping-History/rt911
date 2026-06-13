FROM python:3.14-slim
# ffmpeg + the VAAPI runtime: mesa-va-drivers provides the radeonsi VA driver
# the AMD iGPU encoder needs; libva-drm2 is the DRM backend. With /dev/dri
# mounted, h264_vaapi loads radeonsi automatically. vainfo is for debugging.
RUN apt-get update && apt-get install -y \
        ffmpeg ca-certificates \
        mesa-va-drivers libva2 libva-drm2 vainfo \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml .
COPY video_grabber/ ./video_grabber/
COPY alembic.ini .
RUN pip install --no-cache-dir .
CMD ["python", "-m", "video_grabber.serve"]
