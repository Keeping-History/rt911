package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"classicy/streamer/internal/db"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	goredis "github.com/redis/go-redis/v9"
)

const (
	notifyChannel  = "media_items_changed"
	initialBackoff = 1 * time.Second
	maxBackoff     = 30 * time.Second
)

type changeNotification struct {
	Op string `json:"op"`
	ID int    `json:"id"`
}

// Listen subscribes to Postgres NOTIFY on media_items changes and keeps the
// Redis cache in sync with the database. Intended to run for the process
// lifetime in a dedicated goroutine.
//
// On every (re)connect, Listen resyncs the cache against the database — so
// notifications missed while disconnected are recovered. Reconnects use
// exponential backoff up to 30s.
func Listen(ctx context.Context, dsn string, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) {
	backoff := initialBackoff
	for {
		err := listenOnce(ctx, dsn, rdb, pool, logger)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			logger.Warn("notify listener disconnected", "error", err, "retry_in", backoff)
		}
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return
		}
		if backoff < maxBackoff {
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}
}

func listenOnce(ctx context.Context, dsn string, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(context.Background())

	if _, err := conn.Exec(ctx, "LISTEN "+notifyChannel); err != nil {
		return fmt.Errorf("listen: %w", err)
	}

	// Resync on every (re)attach so we recover from any notifications that
	// were dropped while the listener was disconnected.
	if err := resync(ctx, rdb, pool, logger); err != nil {
		return fmt.Errorf("resync: %w", err)
	}
	logger.Info("notify listener attached", "channel", notifyChannel)

	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}

		var change changeNotification
		if err := json.Unmarshal([]byte(n.Payload), &change); err != nil {
			logger.Warn("notify payload parse failed", "payload", n.Payload, "error", err)
			continue
		}

		if err := applyChange(ctx, rdb, pool, change); err != nil {
			logger.Warn("notify apply failed", "id", change.ID, "op", change.Op, "error", err)
		}
	}
}

func applyChange(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, c changeNotification) error {
	switch c.Op {
	case "delete":
		return Forget(ctx, rdb, c.ID)
	case "insert", "update":
		item, err := db.ItemByID(ctx, pool, c.ID)
		if err != nil {
			return err
		}
		// Row gone or no longer approved → evict from cache.
		if item == nil || item.Approved != 1 {
			return Forget(ctx, rdb, c.ID)
		}
		return Upsert(ctx, rdb, *item)
	default:
		return fmt.Errorf("unknown op %q", c.Op)
	}
}

// resync reconciles Redis with Postgres in one pipeline. After this returns,
// every approved row in Postgres is in the cache, and every cache entry
// corresponds to an approved row.
func resync(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	liveItems, err := db.AllItems(ctx, pool)
	if err != nil {
		return fmt.Errorf("load items: %w", err)
	}
	liveIDs := make(map[string]struct{}, len(liveItems))
	for _, it := range liveItems {
		liveIDs[strconv.Itoa(it.ID)] = struct{}{}
	}

	cacheIDs, err := rdb.ZRange(ctx, keyByStart, 0, -1).Result()
	if err != nil {
		return fmt.Errorf("zrange: %w", err)
	}

	pipe := rdb.Pipeline()
	n := 0
	removed := 0
	for _, id := range cacheIDs {
		if _, ok := liveIDs[id]; !ok {
			pipe.HDel(ctx, keyItems, id)
			pipe.ZRem(ctx, keyByStart, id)
			removed++
			n++
			var err error
			if pipe, err = flushIfFull(ctx, rdb, pipe, n); err != nil {
				return fmt.Errorf("pipeline exec: %w", err)
			}
		}
	}
	for _, it := range liveItems {
		data, err := json.Marshal(it)
		if err != nil {
			continue
		}
		id := strconv.Itoa(it.ID)
		pipe.HSet(ctx, keyItems, id, data)
		pipe.ZAdd(ctx, keyByStart, goredis.Z{Score: float64(it.StartDate.Unix()), Member: id})
		n++
		if pipe, err = flushIfFull(ctx, rdb, pipe, n); err != nil {
			return fmt.Errorf("pipeline exec: %w", err)
		}
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("pipeline exec: %w", err)
	}
	logger.Info("cache resynced", "items", len(liveItems), "removed", removed)
	return nil
}
