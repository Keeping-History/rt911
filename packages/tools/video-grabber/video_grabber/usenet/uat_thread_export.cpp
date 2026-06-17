// uat_thread_export — dump the threaded connectivity of a usenetarchive LZ4
// archive as TSV: one line per message, "<message-id>\t<parent-message-id>",
// with an empty parent for thread roots.
//
// This is the one piece of usenetarchive's restored connectivity (built by
// `connectivity` + `threadify`, including quote-matched links) that the stock
// tools don't expose in a parseable form — `export-messages` writes only raw
// message bodies. We link libuat directly and walk GetMessageId/GetParent, which
// is far more robust than scraping the `query` CLI's index-based output.
//
// Built as part of the usenetarchive image stage (see the worker Dockerfile),
// e.g.:
//   g++ -std=c++14 -O2 -I<uat-src> uat_thread_export.cpp \
//       <uat-build>/libuat/libuat.a <uat-build>/common/libcommon.a -llz4 -lz \
//       -o /usr/local/bin/uat-thread-export
//
// Usage: uat-thread-export <archive-dir>
#include <memory>
#include <stdint.h>
#include <stdio.h>

#include "libuat/Archive.hpp"

int main(int argc, char** argv) {
    if (argc != 2) {
        fprintf(stderr, "USAGE: %s archive\n", argv[0]);
        return 1;
    }
    std::unique_ptr<Archive> archive(Archive::Open(argv[1]));
    if (!archive) {
        fprintf(stderr, "Cannot open archive %s\n", argv[1]);
        return 1;
    }

    const uint32_t n = (uint32_t)archive->NumberOfMessages();
    for (uint32_t i = 0; i < n; i++) {
        const char* msgid = (const char*)archive->GetMessageId(i);
        int32_t parent = archive->GetParent(i);
        const char* pid = (parent >= 0) ? (const char*)archive->GetMessageId((uint32_t)parent) : "";
        printf("%s\t%s\n", msgid, pid);
    }
    return 0;
}
