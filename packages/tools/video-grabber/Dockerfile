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
          import-source-mbox kill-duplicates extract-msgid connectivity \
          extract-msgmeta repack-zstd lexicon lexsort threadify uat-thread-export

# ---- whisper.cpp (Vulkan) build stage -------------------------------------
# Builds whisper-cli with the Vulkan backend so ASR runs on the encode-1 AMD
# iGPU (RADV). MARCH_NATIVE stays off — the binary must run on the encode node,
# not the CI builder. The medium.en ggml model is fetched here and copied into
# the runtime image at /opt/models (deterministic; no runtime network fetch).
FROM python:3.14-slim AS whisper-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates curl build-essential cmake \
        libvulkan-dev glslc spirv-headers \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git
RUN cd whisper.cpp && \
    cmake -B build -DGGML_VULKAN=1 -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release && \
    cmake --build build -j"$(nproc)" --target whisper-cli && \
    cp build/bin/whisper-cli /build/whisper-cli
# whisper.cpp's default build is shared-library: whisper-cli dynamically links
# libwhisper.so.1 and the libggml*.so backends (incl. libggml-vulkan.so). Collect
# every produced .so so the runtime image can resolve them — the binary alone 127s
# with "cannot open shared object file". find is layout-agnostic across whisper
# versions (libs live under build/src and build/ggml/src/**).
RUN mkdir -p /build/whisper-libs && \
    find /build/whisper.cpp/build -name '*.so*' -type f -exec cp -av {} /build/whisper-libs/ \;
RUN cd whisper.cpp && bash ./models/download-ggml-model.sh medium.en && \
    mkdir -p /opt/models && cp models/ggml-medium.en.bin /opt/models/

# ---- runtime image ---------------------------------------------------------
FROM python:3.14-slim
# ffmpeg + the VAAPI runtime (video encode path) plus the shared libs the
# usenetarchive binaries link against. The dev packages are installed (not just
# the versioned runtime libs) so the soname versions match the builder's without
# pinning a Debian-release-specific package name.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg ca-certificates \
        mesa-va-drivers libva2 libva-drm2 vainfo \
        libvulkan1 mesa-vulkan-drivers libgomp1 \
        liblz4-dev libzstd-dev libicu-dev libgmime-3.0-dev libcurl4-openssl-dev libncurses-dev \
    && rm -rf /var/lib/apt/lists/*
# usenetarchive pipeline binaries + our thread exporter.
COPY --from=uat-builder \
        /build/bin/import-source-mbox /build/bin/kill-duplicates \
        /build/bin/extract-msgid /build/bin/connectivity \
        /build/bin/extract-msgmeta /build/bin/repack-zstd \
        /build/bin/lexicon /build/bin/lexsort \
        /build/bin/threadify /build/bin/uat-thread-export \
        /usr/local/bin/
# whisper.cpp Vulkan CLI + its shared libs (libwhisper/libggml*) + the medium.en
# model. ldconfig registers /usr/local/lib so the dynamic linker finds the .so set.
COPY --from=whisper-builder /build/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-builder /build/whisper-libs/ /usr/local/lib/
RUN ldconfig
COPY --from=whisper-builder /opt/models/ /opt/models/
WORKDIR /app
COPY pyproject.toml .
COPY video_grabber/ ./video_grabber/
COPY alembic.ini .
# mbox_parser is a sibling tool (packages/tools/mbox_parser); CI copies it into
# this build context before `docker build`. Installed with its dateutil dep.
COPY mbox_parser.py /usr/local/bin/mbox_parser.py
RUN pip install --no-cache-dir . python-dateutil
ENV USENETARCHIVE_BIN=/usr/local/bin \
    MBOX_PARSER=/usr/local/bin/mbox_parser.py \
    WHISPER_BIN=/usr/local/bin/whisper-cli \
    WHISPER_MODEL=/opt/models/ggml-medium.en.bin
CMD ["python", "-m", "video_grabber.serve"]
