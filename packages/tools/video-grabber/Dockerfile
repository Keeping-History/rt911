FROM python:3.14-slim
RUN apt-get update && apt-get install -y ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml .
COPY video_grabber/ ./video_grabber/
COPY alembic.ini .
RUN pip install --no-cache-dir .
CMD ["python", "-m", "video_grabber.serve"]
