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

const mp3NotifyChannel = "mp3_items_changed"

// rt911_-prefixed so the trigger/function cannot collide with anything Directus
// or another tenant might install on the same table.
var (
	createMp3NotifyFunctionSQL = fmt.Sprintf(`
CREATE OR REPLACE FUNCTION rt911_notify_mp3_items_change()
RETURNS trigger AS $$
DECLARE payload json;
BEGIN
    IF TG_OP = 'DELETE' THEN
        payload = json_build_object('op', 'delete', 'id', OLD.id);
    ELSE
        payload = json_build_object('op', lower(TG_OP), 'id', NEW.id);
    END IF;
    PERFORM pg_notify('%s', payload::text);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;`, mp3NotifyChannel)

	dropMp3NotifyTriggerSQL = `DROP TRIGGER IF EXISTS rt911_mp3_items_changed ON mp3_items;`

	createMp3NotifyTriggerSQL = `
CREATE TRIGGER rt911_mp3_items_changed
AFTER INSERT OR UPDATE OR DELETE ON mp3_items
FOR EACH ROW EXECUTE FUNCTION rt911_notify_mp3_items_change();`
)

// InstallMp3Triggers ensures the Postgres trigger and function that fire NOTIFY
// on mp3_items changes are present. Idempotent — safe to call on every boot.
func InstallMp3Triggers(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	for _, q := range []string{createMp3NotifyFunctionSQL, dropMp3NotifyTriggerSQL, createMp3NotifyTriggerSQL} {
		if _, err := pool.Exec(ctx, q); err != nil {
			return fmt.Errorf("install mp3 triggers: %w", err)
		}
	}
	logger.Info("mp3 notify triggers installed", "channel", mp3NotifyChannel)
	return nil
}

// ListenMp3 subscribes to Postgres NOTIFY on mp3_items changes and keeps the mp3
// Redis cache in sync with the database. Intended to run for the process
// lifetime in a dedicated goroutine. Mirrors Listen: resync on every (re)connect,
// exponential backoff up to 30s.
func ListenMp3(ctx context.Context, dsn string, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) {
	backoff := initialBackoff
	for {
		err := listenMp3Once(ctx, dsn, rdb, pool, logger)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			logger.Warn("mp3 notify listener disconnected", "error", err, "retry_in", backoff)
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

func listenMp3Once(ctx context.Context, dsn string, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(context.Background())

	if _, err := conn.Exec(ctx, "LISTEN "+mp3NotifyChannel); err != nil {
		return fmt.Errorf("listen: %w", err)
	}

	if err := resyncMp3(ctx, rdb, pool, logger); err != nil {
		return fmt.Errorf("resync: %w", err)
	}
	logger.Info("mp3 notify listener attached", "channel", mp3NotifyChannel)

	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}

		var change changeNotification
		if err := json.Unmarshal([]byte(n.Payload), &change); err != nil {
			logger.Warn("mp3 notify payload parse failed", "payload", n.Payload, "error", err)
			continue
		}

		if err := applyMp3Change(ctx, rdb, pool, change); err != nil {
			logger.Warn("mp3 notify apply failed", "id", change.ID, "op", change.Op, "error", err)
		}
	}
}

func applyMp3Change(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, c changeNotification) error {
	switch c.Op {
	case "delete":
		return ForgetMp3(ctx, rdb, c.ID)
	case "insert", "update":
		item, err := db.Mp3ItemByID(ctx, pool, c.ID)
		if err != nil {
			return err
		}
		if item == nil || item.Approved != 1 {
			return ForgetMp3(ctx, rdb, c.ID)
		}
		return UpsertMp3(ctx, rdb, *item)
	default:
		return fmt.Errorf("unknown op %q", c.Op)
	}
}

// resyncMp3 reconciles the mp3 Redis keys with Postgres in one chunked pipeline.
// After this returns, every approved mp3 row is in the cache, and every cache
// entry corresponds to an approved row.
func resyncMp3(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	liveItems, err := db.AllMp3Items(ctx, pool)
	if err != nil {
		return fmt.Errorf("load mp3 items: %w", err)
	}
	liveIDs := make(map[string]struct{}, len(liveItems))
	for _, it := range liveItems {
		liveIDs[strconv.Itoa(it.ID)] = struct{}{}
	}

	cacheIDs, err := rdb.ZRange(ctx, keyMp3ByStart, 0, -1).Result()
	if err != nil {
		return fmt.Errorf("zrange: %w", err)
	}

	pipe := rdb.Pipeline()
	n := 0
	removed := 0
	for _, id := range cacheIDs {
		if _, ok := liveIDs[id]; !ok {
			pipe.HDel(ctx, keyMp3Items, id)
			pipe.ZRem(ctx, keyMp3ByStart, id)
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
		pipe.HSet(ctx, keyMp3Items, id, data)
		pipe.ZAdd(ctx, keyMp3ByStart, goredis.Z{Score: float64(it.StartDate.Unix()), Member: id})
		n++
		if pipe, err = flushIfFull(ctx, rdb, pipe, n); err != nil {
			return fmt.Errorf("pipeline exec: %w", err)
		}
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("pipeline exec: %w", err)
	}
	logger.Info("mp3 cache resynced", "items", len(liveItems), "removed", removed)
	return nil
}
