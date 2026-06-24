package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"time"

	"classicy/streamer/internal/cache"
	"classicy/streamer/internal/db"
	"classicy/streamer/internal/handler"
	"classicy/streamer/internal/session"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	dbURL := env("DATABASE_URL", "postgres://directus:directus@localhost:5432/directus")
	pool, err := db.Connect(dbURL)
	if err != nil {
		logger.Error("database connection failed", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	redisURL := env("REDIS_URL", "redis://localhost:6379")
	rdb := cache.Connect(redisURL)

	ctx := context.Background()

	if err := cache.InstallTriggers(ctx, pool, logger); err != nil {
		logger.Error("trigger install failed", "error", err)
		os.Exit(1)
	}

	if err := cache.WarmCache(ctx, rdb, pool, logger); err != nil {
		logger.Error("cache warm failed", "error", err)
		os.Exit(1)
	}

	// Pager is an opt-in side channel backed by its own table and cache. Its
	// init is best-effort: a missing pager_items table or a pager cache failure
	// must not take down media streaming (and it smooths rollout ordering).
	if err := cache.InstallPagerTriggers(ctx, pool, logger); err != nil {
		logger.Warn("pager trigger install failed; pager channel disabled", "error", err)
	} else if err := cache.WarmPagerCache(ctx, rdb, pool, logger); err != nil {
		logger.Warn("pager cache warm failed; pager channel disabled", "error", err)
	} else {
		go cache.ListenPager(ctx, dbURL, rdb, pool, logger)
	}

	// mp3 (Radio app) is likewise an opt-in side channel with its own table and
	// cache; init is best-effort so it can never take down media streaming.
	if err := cache.InstallMp3Triggers(ctx, pool, logger); err != nil {
		logger.Warn("mp3 trigger install failed; mp3 channel disabled", "error", err)
	} else if err := cache.WarmMp3Cache(ctx, rdb, pool, logger); err != nil {
		logger.Warn("mp3 cache warm failed; mp3 channel disabled", "error", err)
	} else {
		go cache.ListenMp3(ctx, dbURL, rdb, pool, logger)
	}

	// news (News app) — same opt-in side-channel pattern, best-effort init.
	if err := cache.InstallNewsTriggers(ctx, pool, logger); err != nil {
		logger.Warn("news trigger install failed; news channel disabled", "error", err)
	} else if err := cache.WarmNewsCache(ctx, rdb, pool, logger); err != nil {
		logger.Warn("news cache warm failed; news channel disabled", "error", err)
	} else {
		go cache.ListenNews(ctx, dbURL, rdb, pool, logger)
	}

	// usenet (Newsgroups app) is intentionally NOT cached in Redis: messages carry
	// full bodies and the corpus is far too large to warm. The channel reads
	// Postgres directly (per-group, gated by what the client is viewing) — see
	// session.RunTimePump and db.UsenetItemsInRange.

	// Keep Redis in sync with tv_channels changes for the process lifetime.
	go cache.Listen(ctx, dbURL, rdb, pool, logger)

	hub := session.NewHub(logger)
	go hub.Run()

	addr := env("LISTEN_ADDR", ":8080")

	mux := http.NewServeMux()
	mux.HandleFunc("/stream", handler.NewWSHandler(hub, rdb, pool, logger))
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) {
		readyCtx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := pool.Ping(readyCtx); err != nil {
			http.Error(w, "postgres: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		if err := rdb.Ping(readyCtx).Err(); err != nil {
			http.Error(w, "redis: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	logger.Info("streamer listening", "addr", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		logger.Error("server exited", "error", err)
		os.Exit(1)
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
