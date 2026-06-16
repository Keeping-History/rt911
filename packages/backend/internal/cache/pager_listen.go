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

const pagerNotifyChannel = "pager_items_changed"

// The trigger and function names are rt911_-prefixed so they cannot collide
// with anything Directus or another tenant might install on the same table.
var (
	createPagerNotifyFunctionSQL = fmt.Sprintf(`
CREATE OR REPLACE FUNCTION rt911_notify_pager_items_change()
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
$$ LANGUAGE plpgsql;`, pagerNotifyChannel)

	dropPagerNotifyTriggerSQL = `DROP TRIGGER IF EXISTS rt911_pager_items_changed ON pager_items;`

	createPagerNotifyTriggerSQL = `
CREATE TRIGGER rt911_pager_items_changed
AFTER INSERT OR UPDATE OR DELETE ON pager_items
FOR EACH ROW EXECUTE FUNCTION rt911_notify_pager_items_change();`
)

// InstallPagerTriggers ensures the Postgres trigger and function that fire
// NOTIFY on pager_items changes are present. Idempotent — safe to call on every
// boot.
func InstallPagerTriggers(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	for _, q := range []string{createPagerNotifyFunctionSQL, dropPagerNotifyTriggerSQL, createPagerNotifyTriggerSQL} {
		if _, err := pool.Exec(ctx, q); err != nil {
			return fmt.Errorf("install pager triggers: %w", err)
		}
	}
	logger.Info("pager notify triggers installed", "channel", pagerNotifyChannel)
	return nil
}

// ListenPager subscribes to Postgres NOTIFY on pager_items changes and keeps the
// pager Redis cache in sync with the database. Intended to run for the process
// lifetime in a dedicated goroutine. Mirrors Listen: resync on every (re)connect,
// exponential backoff up to 30s.
func ListenPager(ctx context.Context, dsn string, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) {
	backoff := initialBackoff
	for {
		err := listenPagerOnce(ctx, dsn, rdb, pool, logger)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			logger.Warn("pager notify listener disconnected", "error", err, "retry_in", backoff)
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

func listenPagerOnce(ctx context.Context, dsn string, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(context.Background())

	if _, err := conn.Exec(ctx, "LISTEN "+pagerNotifyChannel); err != nil {
		return fmt.Errorf("listen: %w", err)
	}

	if err := resyncPager(ctx, rdb, pool, logger); err != nil {
		return fmt.Errorf("resync: %w", err)
	}
	logger.Info("pager notify listener attached", "channel", pagerNotifyChannel)

	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}

		var change changeNotification
		if err := json.Unmarshal([]byte(n.Payload), &change); err != nil {
			logger.Warn("pager notify payload parse failed", "payload", n.Payload, "error", err)
			continue
		}

		if err := applyPagerChange(ctx, rdb, pool, change); err != nil {
			logger.Warn("pager notify apply failed", "id", change.ID, "op", change.Op, "error", err)
		}
	}
}

func applyPagerChange(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, c changeNotification) error {
	switch c.Op {
	case "delete":
		return ForgetPager(ctx, rdb, c.ID)
	case "insert", "update":
		item, err := db.PagerItemByID(ctx, pool, c.ID)
		if err != nil {
			return err
		}
		if item == nil || item.Approved != 1 {
			return ForgetPager(ctx, rdb, c.ID)
		}
		return UpsertPager(ctx, rdb, *item)
	default:
		return fmt.Errorf("unknown op %q", c.Op)
	}
}

// resyncPager reconciles the pager Redis keys with Postgres in one pipeline.
// After this returns, every approved pager row is in the cache, and every cache
// entry corresponds to an approved row.
func resyncPager(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	liveItems, err := db.AllPagerItems(ctx, pool)
	if err != nil {
		return fmt.Errorf("load pager items: %w", err)
	}
	liveIDs := make(map[string]struct{}, len(liveItems))
	for _, it := range liveItems {
		liveIDs[strconv.Itoa(it.ID)] = struct{}{}
	}

	cacheIDs, err := rdb.ZRange(ctx, keyPagerByStart, 0, -1).Result()
	if err != nil {
		return fmt.Errorf("zrange: %w", err)
	}

	pipe := rdb.Pipeline()
	removed := 0
	for _, id := range cacheIDs {
		if _, ok := liveIDs[id]; !ok {
			pipe.HDel(ctx, keyPagerItems, id)
			pipe.ZRem(ctx, keyPagerByStart, id)
			removed++
		}
	}
	for _, it := range liveItems {
		data, err := json.Marshal(it)
		if err != nil {
			continue
		}
		id := strconv.Itoa(it.ID)
		pipe.HSet(ctx, keyPagerItems, id, data)
		pipe.ZAdd(ctx, keyPagerByStart, goredis.Z{Score: float64(it.StartDate.Unix()), Member: id})
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("pipeline exec: %w", err)
	}
	logger.Info("pager cache resynced", "items", len(liveItems), "removed", removed)
	return nil
}
