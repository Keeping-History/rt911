# ---- usenetarchive build stage --------------------------------------------
# Builds the stock usenetarchive C++ tools used by the usenet threading pipeline,
# plus our custom uat-thread-export (links libuat to dump the restored thread
# graph as TSV). Based on the SAME python:3.14-slim as the runtime stage so the
# C++ shared libraries (lz4/zstd/icu/gmime/curl) match versions exactly. CMake
# fetches Tracy via CPM at configure time, so this stage needs network + git.
# MARCH_NATIVE is OFF — the binaries must run on the encode node, not just the
# CI builder's CPU.
FROM python:3.14-slim AS uat-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates build-essential pkg-config \
        libcurl4-openssl-dev libssl-dev libicu-dev libncurses-dev \
        libgmime-3.0-dev liblz4-dev libzstd-dev \
    && rm -rf /var/lib/apt/lists/*
# usenetarchive requires CMake >= 3.29; Debian ships older, so use pip's wheel.
RUN pip install --no-cache-dir "cmake>=3.29"
WORKDIR /build
RUN git clone --depth 1 https://github.com/wolfpld/usenetarchive.git
# Add our tool to usenetarchive's own CMake build. It uses libuat::Archive, so it
# links exactly like the `query` tool (common zstd libuat); the extra include dir
# lets it resolve "libuat/Archive.hpp" from the source root.
COPY video_grabber/usenet/uat_thread_export.cpp /build/usenetarchive/thread-export/uat_thread_export.cpp
RUN cd usenetarchive && \
    { echo ''; \
      echo 'add_executable(uat-thread-export thread-export/uat_thread_export.cpp)'; \
      echo 'target_link_libraries(uat-thread-export PRIVATE common zstd libuat)'; \
      echo 'target_include_directories(uat-thread-export PRIVATE ${CMAKE_SOURCE_DIR})'; \
    } >> CMakeLists.txt && \
    cmake -B build -DCMAKE_BUILD_TYPE=Release -DMARCH_NATIVE=OFF \
          -DCMAKE_RUNTIME_OUTPUT_DIRECTORY=/build/bin && \
    cmake --build build -j"$(nproc)" --target \
          import-source-mbox kill-duplicates extract-msgid connectivity threadify uat-thread-export

# ---- runtime image ---------------------------------------------------------
FROM python:3.14-slim
# ffmpeg + the VAAPI runtime (video encode path) plus the shared libs the
# usenetarchive binaries link against. The dev packages are installed (not just
# the versioned runtime libs) so the soname versions match the builder's without
# pinning a Debian-release-specific package name.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg ca-certificates \
        mesa-va-drivers libva2 libva-drm2 vainfo \
        liblz4-dev libzstd-dev libicu-dev libgmime-3.0-dev libcurl4-openssl-dev libncurses-dev \
    && rm -rf /var/lib/apt/lists/*
# usenetarchive pipeline binaries + our thread exporter.
COPY --from=uat-builder \
        /build/bin/import-source-mbox /build/bin/kill-duplicates \
        /build/bin/extract-msgid /build/bin/connectivity \
        /build/bin/threadify /build/bin/uat-thread-export \
        /usr/local/bin/
WORKDIR /app
COPY pyproject.toml .
COPY video_grabber/ ./video_grabber/
COPY alembic.ini .
# mbox_parser is a sibling tool (packages/tools/mbox_parser); CI copies it into
# this build context before `docker build`. Installed with its dateutil dep.
COPY mbox_parser.py /usr/local/bin/mbox_parser.py
RUN pip install --no-cache-dir . python-dateutil
ENV USENETARCHIVE_BIN=/usr/local/bin \
    MBOX_PARSER=/usr/local/bin/mbox_parser.py
CMD ["python", "-m", "video_grabber.serve"]
