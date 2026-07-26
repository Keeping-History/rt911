package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"classicy/streamer/internal/cache"
	"classicy/streamer/internal/chat"
	"classicy/streamer/internal/clock"
	"classicy/streamer/internal/db"
	"classicy/streamer/internal/handler"
	"classicy/streamer/internal/session"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	dbURL := env("DATABASE_URL", "postgres://directus:directus@localhost:5432/directus")
	pool, err := db.Connect(dbURL, db.PoolConfig{
		MaxConns:          int32(envInt("DB_MAX_CONNS", 20)),
		MinConns:          int32(envInt("DB_MIN_CONNS", 2)),
		MaxConnLifetime:   envDur("DB_MAX_CONN_LIFETIME", time.Hour),
		MaxConnIdleTime:   envDur("DB_MAX_CONN_IDLE_TIME", 30*time.Minute),
		HealthCheckPeriod: envDur("DB_HEALTH_CHECK_PERIOD", time.Minute),
	})
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

	// alerts (Alerts extension) — same opt-in side-channel pattern, best-effort init.
	if err := cache.InstallAlertTriggers(ctx, pool, logger); err != nil {
		logger.Warn("alert trigger install failed; alerts channel disabled", "error", err)
	} else if err := cache.WarmAlertCache(ctx, rdb, pool, logger); err != nil {
		logger.Warn("alert cache warm failed; alerts channel disabled", "error", err)
	} else {
		go cache.ListenAlert(ctx, dbURL, rdb, pool, logger)
	}

	// flights is an opt-in side channel like pager, but with no triggers and no
	// listener: flight positions are immutable bulk data loaded via COPY (which
	// bypasses row triggers anyway), so the boot warm is the only sync. After a
	// flight-recon re-load: `DEL flight:minutes` + restart to rewarm. Best-effort
	// like every side channel — a failure must not take down media streaming.
	if err := cache.WarmFlightCache(ctx, rdb, pool, logger); err != nil {
		logger.Warn("flight cache warm failed; flights channel will serve empty or partial windows", "error", err)
	}

	// usenet (Newsgroups app) is intentionally NOT cached in Redis: messages carry
	// full bodies and the corpus is far too large to warm. The channel reads
	// Postgres directly (per-group, gated by what the client is viewing) — see
	// session.RunTimePump and db.UsenetItemsInRange.

	// Keep Redis in sync with tv_channels changes for the process lifetime.
	go cache.Listen(ctx, dbURL, rdb, pool, logger)

	// MAX_SESSIONS caps concurrent connections per pod for load-shedding; 0 means
	// unlimited. Set it (from a load-tested per-pod ceiling) so an overloaded pod
	// rejects new connections with 503 instead of crashing under the weight.
	hub := session.NewHub(logger, envInt("MAX_SESSIONS", 0))
	go hub.Run()

	// Forced clock mode: operator-set master clock, persisted in Redis so a
	// restart mid-session stays forced. OnChange broadcasts to every session;
	// late joiners get their frame from the connect path in the WS handler.
	masterClock := clock.New(rdb, logger)
	masterClock.OnChange(func(st clock.State) { hub.BroadcastClock(st) })
	if err := masterClock.Load(ctx); err != nil {
		logger.Warn("master clock load failed; starting unforced", "error", err)
	}
	hub.SetMaster(masterClock)
	go masterClock.Run(ctx)

	// Chat's reply engine. Credentials come from the environment only, never
	// from Directus (CLAUDE.md). A missing key just means one fewer provider is
	// registered; only when NO provider ends up configured does chat stay
	// entirely disabled (Generator stays nil, ChatSend degrades every send to
	// the in-character stall) — media streaming is unaffected either way.
	providers := make(map[string]chat.Provider)
	if key := env("ANTHROPIC_API_KEY", ""); key != "" {
		providers["anthropic"] = chat.NewAnthropicProvider(key, logger)
	} else {
		logger.Warn("ANTHROPIC_API_KEY unset; anthropic chat provider disabled")
	}
	if key := env("OPENAI_API_KEY", ""); key != "" {
		providers["openai"] = chat.NewOpenAICompatProvider(key, "", "openai", logger)
	} else {
		logger.Warn("OPENAI_API_KEY unset; openai chat provider disabled")
	}
	if key := env("OPENROUTER_API_KEY", ""); key != "" {
		providers["openrouter"] = chat.NewOpenAICompatProvider(key, env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"), "openrouter", logger)
	} else {
		logger.Warn("OPENROUTER_API_KEY unset; openrouter chat provider disabled")
	}
	if len(providers) == 0 {
		logger.Warn("no chat provider configured; chat channel will stay disabled")
	} else {
		settingsCtx, settingsCancel := context.WithTimeout(ctx, 2*time.Second)
		settings, err := chat.LoadSettings(settingsCtx, pool)
		settingsCancel()
		if err != nil {
			logger.Warn("chat settings unavailable; using shipped defaults", "error", err)
			settings = chat.ShippedDefaults
		}
		gen := chat.NewGenerator(pool, providers, settings,
			envDur("CHAT_SETTINGS_TTL", time.Minute),
			envInt("CHAT_WORKERS", 4), envInt("CHAT_QUEUE", 32), logger)
		hub.SetGenerator(gen)
		logger.Info("chat generator ready", "providers", len(providers))
	}

	addr := env("LISTEN_ADDR", ":8080")

	// sendSources' four queries are identical for every client and time-independent;
	// memoize them so a connection storm doesn't re-run them per init.
	sourcesCache := db.NewSourcesCache(pool, 5*time.Minute)

	// Chat profiles are a side channel: a load failure must not stop the streamer.
	// This runs before the mux is served, so a hang (not just an error) — e.g. this
	// read blocking behind a schema operation or a pg_dump's ACCESS SHARE lock —
	// must not delay the pod from listening. Bound it with a short timeout and
	// treat expiry exactly like the existing error path.
	chatProfiles := handler.NewProfileCache()
	chatLoadCtx, chatLoadCancel := context.WithTimeout(ctx, 2*time.Second)
	profiles, err := chat.LoadProfiles(chatLoadCtx, pool)
	chatLoadCancel()
	if err != nil {
		logger.Warn("chat profiles unavailable, chat roster will be empty", "error", err)
	} else {
		chatProfiles.Set(profiles)
		logger.Info("chat profiles loaded", "count", len(profiles))
	}

	// Beacons/phases resolve each buddy's emotional arc across the virtual
	// clock (chat.PhaseAt); without them every job would render with
	// chat.DefaultPhase all day regardless of the clock. Same non-fatal,
	// bounded, load-once pattern as profiles above — a missing table or a slow
	// query degrades buddies to the default phase, it must never delay the pod
	// from listening.
	beaconCtx, beaconCancel := context.WithTimeout(ctx, 2*time.Second)
	beacons, err := chat.LoadBeacons(beaconCtx, pool)
	beaconCancel()
	if err != nil {
		logger.Warn("chat beacons unavailable, buddies will use the default phase", "error", err)
		beacons = nil
	}
	phaseCtx, phaseCancel := context.WithTimeout(ctx, 2*time.Second)
	phases, err := chat.LoadPhases(phaseCtx, pool)
	phaseCancel()
	if err != nil {
		logger.Warn("chat phases unavailable, buddies will use the default phase", "error", err)
		phases = nil
	}
	chatProfiles.SetPhaseData(beacons, phases)

	// Scheduled beats (chat_schedules) let a buddy message first, anchored to a
	// beacon's public_at. The live table has zero rows, so this is inert until
	// a curator adds content — same non-fatal, bounded, load-once pattern as
	// beacons/phases above.
	scheduleCtx, scheduleCancel := context.WithTimeout(ctx, 2*time.Second)
	schedules, err := chat.LoadSchedules(scheduleCtx, pool)
	scheduleCancel()
	if err != nil {
		logger.Warn("chat schedules unavailable, buddies will not message first", "error", err)
		schedules = nil
	}
	chatProfiles.SetSchedules(schedules)

	// Which signals reached where. Local stations are market-scoped so a buddy
	// in Ohio cannot quote Channel 5 New York; national and international reach
	// everyone. An unclassified source still reaches everyone — dropping it
	// would make adding a channel silently mute it — so the gap is logged
	// instead. Same non-fatal, bounded, load-once pattern as above. On failure
	// bcastSources stays nil and AllowedFor returns an unfiltered query, so a
	// config-load failure degrades to the pre-existing behaviour rather than
	// muting every buddy's broadcast tier.
	bcastCtx, bcastCancel := context.WithTimeout(ctx, 2*time.Second)
	bcastSources, err := chat.LoadBroadcastSources(bcastCtx, pool)
	bcastCancel()
	if err != nil {
		logger.Warn("chat broadcast classification unavailable, all sources reach every buddy", "error", err)
		bcastSources = nil
	}
	if gaps := chat.UnclassifiedNames(bcastSources); len(gaps) > 0 {
		logger.Warn("chat broadcast sources missing reach classification", "sources", gaps)
	}
	chatProfiles.SetBroadcastSources(bcastSources)

	// Only these origins may turn a Directus session cookie into a chat
	// identity. CHAT_TRUSTED_ORIGINS appends to the built-in production list so
	// dev and preview origins never ship in production config.
	trustedOrigins := handler.NewOriginAllowlist(env("CHAT_TRUSTED_ORIGINS", ""))

	mux := http.NewServeMux()
	mux.HandleFunc("/stream", handler.NewWSHandler(hub, rdb, pool, sourcesCache, chatProfiles, trustedOrigins, logger))
	if env("CHAT_DEV_UI", "") == "1" {
		mux.HandleFunc("/chatdev", handler.NewChatDevHandler(logger))
		logger.Warn("chat dev harness enabled at /chatdev — do not enable in production")
	}
	mux.HandleFunc("/feedback", handler.NewFeedbackHandler(
		env("GITHUB_API_URL", "https://api.github.com"),
		env("S3_ENDPOINT", "https://s3.wasabisys.com"),
		env("S3_BUCKET", "rt911-feedback"),
		env("S3_ACCESS_KEY", ""),
		env("S3_SECRET_KEY", ""),
		env("GITHUB_TOKEN", ""),
		logger,
	))
	mux.HandleFunc("/clock", handler.NewClockHandler(masterClock, env("CLOCK_CONTROL_KEY", ""), logger))
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

// envInt reads key as an int, falling back on an unset/empty/unparseable value.
func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

// envDur reads key as a Go duration (e.g. "30s", "1h"), falling back on an
// unset/empty/unparseable value.
func envDur(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return fallback
}
