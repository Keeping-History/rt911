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

const usenetNotifyChannel = "usenet_items_changed"

// rt911_-prefixed so the trigger/function cannot collide with anything Directus
// or another tenant might install on the same table.
var (
	createUsenetNotifyFunctionSQL = fmt.Sprintf(`
CREATE OR REPLACE FUNCTION rt911_notify_usenet_items_change()
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
$$ LANGUAGE plpgsql;`, usenetNotifyChannel)

	dropUsenetNotifyTriggerSQL = `DROP TRIGGER IF EXISTS rt911_usenet_items_changed ON usenet_items;`

	createUsenetNotifyTriggerSQL = `
CREATE TRIGGER rt911_usenet_items_changed
AFTER INSERT OR UPDATE OR DELETE ON usenet_items
FOR EACH ROW EXECUTE FUNCTION rt911_notify_usenet_items_change();`
)

// InstallUsenetTriggers ensures the Postgres trigger and function that fire NOTIFY
// on usenet_items changes are present. Idempotent — safe to call on every boot.
func InstallUsenetTriggers(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	for _, q := range []string{createUsenetNotifyFunctionSQL, dropUsenetNotifyTriggerSQL, createUsenetNotifyTriggerSQL} {
		if _, err := pool.Exec(ctx, q); err != nil {
			return fmt.Errorf("install usenet triggers: %w", err)
		}
	}
	logger.Info("usenet notify triggers installed", "channel", usenetNotifyChannel)
	return nil
}

// ListenUsenet subscribes to Postgres NOTIFY on usenet_items changes and keeps the
// usenet Redis cache in sync with the database. Intended to run for the process
// lifetime in a dedicated goroutine. Mirrors ListenNews: resync on every
// (re)connect, exponential backoff up to 30s.
func ListenUsenet(ctx context.Context, dsn string, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) {
	backoff := initialBackoff
	for {
		err := listenUsenetOnce(ctx, dsn, rdb, pool, logger)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			logger.Warn("usenet notify listener disconnected", "error", err, "retry_in", backoff)
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

func listenUsenetOnce(ctx context.Context, dsn string, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(context.Background())

	if _, err := conn.Exec(ctx, "LISTEN "+usenetNotifyChannel); err != nil {
		return fmt.Errorf("listen: %w", err)
	}

	if err := resyncUsenet(ctx, rdb, pool, logger); err != nil {
		return fmt.Errorf("resync: %w", err)
	}
	logger.Info("usenet notify listener attached", "channel", usenetNotifyChannel)

	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}

		var change changeNotification
		if err := json.Unmarshal([]byte(n.Payload), &change); err != nil {
			logger.Warn("usenet notify payload parse failed", "payload", n.Payload, "error", err)
			continue
		}

		if err := applyUsenetChange(ctx, rdb, pool, change); err != nil {
			logger.Warn("usenet notify apply failed", "id", change.ID, "op", change.Op, "error", err)
		}
	}
}

func applyUsenetChange(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, c changeNotification) error {
	switch c.Op {
	case "delete":
		return ForgetUsenet(ctx, rdb, c.ID)
	case "insert", "update":
		item, err := db.UsenetItemByID(ctx, pool, c.ID)
		if err != nil {
			return err
		}
		if item == nil || item.Approved != 1 {
			return ForgetUsenet(ctx, rdb, c.ID)
		}
		return UpsertUsenet(ctx, rdb, *item)
	default:
		return fmt.Errorf("unknown op %q", c.Op)
	}
}

// resyncUsenet reconciles the usenet Redis keys with Postgres. After this returns,
// every approved row is cached and every cache entry corresponds to an approved
// row. Stale entries are dropped via ForgetUsenet (which reads back the group from
// the stored JSON to find the right per-group ZSET); live rows are re-added in a
// chunked pipeline.
func resyncUsenet(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	liveItems, err := db.AllUsenetItems(ctx, pool)
	if err != nil {
		return fmt.Errorf("load usenet items: %w", err)
	}
	liveIDs := make(map[string]struct{}, len(liveItems))
	for _, it := range liveItems {
		liveIDs[strconv.Itoa(it.ID)] = struct{}{}
	}

	cacheIDs, err := rdb.HKeys(ctx, keyUsenetItems).Result()
	if err != nil {
		return fmt.Errorf("hkeys: %w", err)
	}

	removed := 0
	for _, id := range cacheIDs {
		if _, ok := liveIDs[id]; ok {
			continue
		}
		n, _ := strconv.Atoi(id)
		if err := ForgetUsenet(ctx, rdb, n); err != nil {
			return fmt.Errorf("forget stale: %w", err)
		}
		removed++
	}

	pipe := rdb.Pipeline()
	written := 0
	for _, it := range liveItems {
		data, err := json.Marshal(it)
		if err != nil {
			continue
		}
		id := strconv.Itoa(it.ID)
		pipe.HSet(ctx, keyUsenetItems, id, data)
		pipe.ZAdd(ctx, usenetGroupKey(it.Newsgroup), goredis.Z{Score: float64(it.StartDate.Unix()), Member: id})
		written++
		if pipe, err = flushIfFull(ctx, rdb, pipe, written); err != nil {
			return fmt.Errorf("pipeline exec: %w", err)
		}
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("pipeline exec: %w", err)
	}
	logger.Info("usenet cache resynced", "items", len(liveItems), "removed", removed)
	return nil
}
