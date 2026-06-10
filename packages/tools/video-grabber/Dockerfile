FROM python:3.12-slim
RUN apt-get update && apt-get install -y ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml .
RUN pip install --no-cache-dir -e .
COPY video_grabber/ ./video_grabber/
CMD ["prefect", "worker", "start", "--pool", "video-grabber-pool"]
