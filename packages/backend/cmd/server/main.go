package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"classicy/streamer/internal/cache"
	"classicy/streamer/internal/chat"
	"classicy/streamer/internal/clock"
	"classicy/streamer/internal/db"
	"classicy/streamer/internal/handler"
	"classicy/streamer/internal/session"

	"github.com/jackc/pgx/v5/pgxpool"
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
	// Closed by shutdown() instead of deferred: main can now return normally, so
	// a defer here would double-close what shutdown already released.

	redisURL, redisWriteURL := cache.ResolveRedisURLs(
		env("REDIS_URL", "redis://localhost:6379"),
		env("REDIS_WRITE_URL", ""))
	rdb := cache.Connect(redisURL)
	// rdbWrite is a distinct client only when REDIS_WRITE_URL diverges from
	// REDIS_URL (a read-replica deployment): cache warms and the master clock
	// go through it so a replica pod still writes through to the primary.
	// Unset REDIS_WRITE_URL keeps rdbWrite == rdb — same single client
	// instance as before this seam existed.
	rdbWrite := rdb
	if redisWriteURL != redisURL {
		rdbWrite = cache.Connect(redisWriteURL)
	}

	ctx := context.Background()

	if err := cache.InstallTriggers(ctx, pool, logger); err != nil {
		logger.Error("trigger install failed", "error", err)
		os.Exit(1)
	}

	if err := cache.WarmCache(ctx, rdbWrite, pool, logger); err != nil {
		logger.Error("cache warm failed", "error", err)
		os.Exit(1)
	}

	// Pager is an opt-in side channel backed by its own table and cache. Its
	// init is best-effort: a missing pager_items table or a pager cache failure
	// must not take down media streaming (and it smooths rollout ordering).
	if err := cache.InstallPagerTriggers(ctx, pool, logger); err != nil {
		logger.Warn("pager trigger install failed; pager channel disabled", "error", err)
	} else if err := cache.WarmPagerCache(ctx, rdbWrite, pool, logger); err != nil {
		logger.Warn("pager cache warm failed; pager channel disabled", "error", err)
	} else {
		go cache.ListenPager(ctx, dbURL, rdb, pool, logger)
	}

	// mp3 (Radio app) is likewise an opt-in side channel with its own table and
	// cache; init is best-effort so it can never take down media streaming.
	if err := cache.InstallMp3Triggers(ctx, pool, logger); err != nil {
		logger.Warn("mp3 trigger install failed; mp3 channel disabled", "error", err)
	} else if err := cache.WarmMp3Cache(ctx, rdbWrite, pool, logger); err != nil {
		logger.Warn("mp3 cache warm failed; mp3 channel disabled", "error", err)
	} else {
		go cache.ListenMp3(ctx, dbURL, rdb, pool, logger)
	}

	// news (News app) — same opt-in side-channel pattern, best-effort init.
	if err := cache.InstallNewsTriggers(ctx, pool, logger); err != nil {
		logger.Warn("news trigger install failed; news channel disabled", "error", err)
	} else if err := cache.WarmNewsCache(ctx, rdbWrite, pool, logger); err != nil {
		logger.Warn("news cache warm failed; news channel disabled", "error", err)
	} else {
		go cache.ListenNews(ctx, dbURL, rdb, pool, logger)
	}

	// alerts (Alerts extension) — same opt-in side-channel pattern, best-effort init.
	if err := cache.InstallAlertTriggers(ctx, pool, logger); err != nil {
		logger.Warn("alert trigger install failed; alerts channel disabled", "error", err)
	} else if err := cache.WarmAlertCache(ctx, rdbWrite, pool, logger); err != nil {
		logger.Warn("alert cache warm failed; alerts channel disabled", "error", err)
	} else {
		go cache.ListenAlert(ctx, dbURL, rdb, pool, logger)
	}

	// flights is an opt-in side channel like pager, but with no triggers and no
	// listener: flight positions are immutable bulk data loaded via COPY (which
	// bypasses row triggers anyway), so the boot warm is the only sync. After a
	// flight-recon re-load: `DEL flight:minutes` + restart to rewarm. Best-effort
	// like every side channel — a failure must not take down media streaming.
	if err := cache.WarmFlightCache(ctx, rdbWrite, pool, cache.KeyFlightMinutes, false, logger); err != nil {
		logger.Warn("flight cache warm failed; flights channel will serve empty or partial windows", "error", err)
	}
	if err := cache.WarmFlightCache(ctx, rdbWrite, pool, cache.KeyFlightAnonMinutes, true, logger); err != nil {
		logger.Warn("flights-anon cache warm failed; anonymous traffic will serve empty or partial windows", "error", err)
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
	masterClock := clock.New(rdbWrite, logger)
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
	var gen *chat.Generator
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
		// A base URL set in chat_settings beats the env default, so an operator
		// can repoint an OpenAI-compatible endpoint without a redeploy -- which
		// is the whole reason those defaults live in Directus.
		if settings.OpenAIBaseURL != "" {
			if key := env("OPENAI_API_KEY", ""); key != "" {
				providers["openai"] = chat.NewOpenAICompatProvider(key, settings.OpenAIBaseURL, "openai", logger)
				logger.Info("openai base url overridden from chat_settings", "base_url", settings.OpenAIBaseURL)
			}
		}
		gen = chat.NewGenerator(pool, providers, settings,
			envDur("CHAT_SETTINGS_TTL", time.Minute),
			envInt("CHAT_WORKERS", 4), envInt("CHAT_QUEUE_SIZE", 256), logger)
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
	if bad := chat.UnwatchableNames(bcastSources, profiles); len(bad) > 0 {
		logger.Warn("chat profiles watching a source they cannot receive; falling back to everything in their market", "profiles", bad)
	}
	chatProfiles.SetBroadcastSources(bcastSources)

	// Only these origins may turn a Directus session cookie into a chat
	// identity. CHAT_TRUSTED_ORIGINS appends to the built-in production list so
	// dev and preview origins never ship in production config.
	trustedOrigins := handler.NewOriginAllowlist(env("CHAT_TRUSTED_ORIGINS", ""))

	mux := http.NewServeMux()
	mux.HandleFunc("/stream", handler.NewWSHandler(hub, rdb, pool, sourcesCache, chatProfiles, trustedOrigins, logger))
	// Answers "may I take this screen name?", which the browser cannot: reads on
	// directus_users are scoped to $CURRENT_USER, so a client-side lookup returns
	// zero rows for every name and would report "available" for taken ones.
	// Authenticated, so it is not an open oracle for who holds which name.
	mux.HandleFunc("/chat/username-available", handler.NewUsernameAvailableHandler(pool, trustedOrigins, logger))
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

	// Shut down on SIGTERM rather than being killed mid-flight. Kubernetes
	// sends it on every rollout, and without this nothing deferred in main ever
	// runs: the pool is never closed, and the generator's whole drain path --
	// finish in-flight work, hand queued jobs ErrShuttingDown, log the count --
	// is unreachable code. os.Exit skips defers, so the shutdown sequence is
	// explicit here rather than deferred.
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	srv := &http.Server{Addr: addr, Handler: mux}
	serveErr := make(chan error, 1)
	go func() {
		logger.Info("streamer listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()

	select {
	case err := <-serveErr:
		logger.Error("server exited", "error", err)
		shutdown(srv, gen, pool, logger)
		os.Exit(1)
	case <-ctx.Done():
		logger.Info("signal received, shutting down")
		shutdown(srv, gen, pool, logger)
	}
}

// shutdownGrace bounds the whole sequence. Kubernetes' default grace period is
// 30s and it SIGKILLs after that, so finish well inside it: the generator's
// drain is designed to return promptly rather than wait on queued network
// calls, and a WebSocket client reconnects on its own.
const shutdownGrace = 10 * time.Second

func shutdown(srv *http.Server, gen *chat.Generator, pool *pgxpool.Pool, logger *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		logger.Warn("http shutdown did not finish cleanly", "error", err)
	}
	// After the listener is closed, so no new job can be accepted while the
	// queue drains.
	if gen != nil {
		gen.Close()
	}
	pool.Close()
	logger.Info("shutdown complete")
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
