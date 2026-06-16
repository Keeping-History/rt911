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

const newsNotifyChannel = "news_items_changed"

// rt911_-prefixed so the trigger/function cannot collide with anything Directus
// or another tenant might install on the same table.
var (
	createNewsNotifyFunctionSQL = fmt.Sprintf(`
CREATE OR REPLACE FUNCTION rt911_notify_news_items_change()
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
$$ LANGUAGE plpgsql;`, newsNotifyChannel)

	dropNewsNotifyTriggerSQL = `DROP TRIGGER IF EXISTS rt911_news_items_changed ON news_items;`

	createNewsNotifyTriggerSQL = `
CREATE TRIGGER rt911_news_items_changed
AFTER INSERT OR UPDATE OR DELETE ON news_items
FOR EACH ROW EXECUTE FUNCTION rt911_notify_news_items_change();`
)

// InstallNewsTriggers ensures the Postgres trigger and function that fire NOTIFY
// on news_items changes are present. Idempotent — safe to call on every boot.
func InstallNewsTriggers(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	for _, q := range []string{createNewsNotifyFunctionSQL, dropNewsNotifyTriggerSQL, createNewsNotifyTriggerSQL} {
		if _, err := pool.Exec(ctx, q); err != nil {
			return fmt.Errorf("install news triggers: %w", err)
		}
	}
	logger.Info("news notify triggers installed", "channel", newsNotifyChannel)
	return nil
}

// ListenNews subscribes to Postgres NOTIFY on news_items changes and keeps the
// news Redis cache in sync with the database. Intended to run for the process
// lifetime in a dedicated goroutine. Mirrors Listen: resync on every (re)connect,
// exponential backoff up to 30s.
func ListenNews(ctx context.Context, dsn string, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) {
	backoff := initialBackoff
	for {
		err := listenNewsOnce(ctx, dsn, rdb, pool, logger)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			logger.Warn("news notify listener disconnected", "error", err, "retry_in", backoff)
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

func listenNewsOnce(ctx context.Context, dsn string, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(context.Background())

	if _, err := conn.Exec(ctx, "LISTEN "+newsNotifyChannel); err != nil {
		return fmt.Errorf("listen: %w", err)
	}

	if err := resyncNews(ctx, rdb, pool, logger); err != nil {
		return fmt.Errorf("resync: %w", err)
	}
	logger.Info("news notify listener attached", "channel", newsNotifyChannel)

	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}

		var change changeNotification
		if err := json.Unmarshal([]byte(n.Payload), &change); err != nil {
			logger.Warn("news notify payload parse failed", "payload", n.Payload, "error", err)
			continue
		}

		if err := applyNewsChange(ctx, rdb, pool, change); err != nil {
			logger.Warn("news notify apply failed", "id", change.ID, "op", change.Op, "error", err)
		}
	}
}

func applyNewsChange(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, c changeNotification) error {
	switch c.Op {
	case "delete":
		return ForgetNews(ctx, rdb, c.ID)
	case "insert", "update":
		item, err := db.NewsItemByID(ctx, pool, c.ID)
		if err != nil {
			return err
		}
		if item == nil || item.Approved != 1 {
			return ForgetNews(ctx, rdb, c.ID)
		}
		return UpsertNews(ctx, rdb, *item)
	default:
		return fmt.Errorf("unknown op %q", c.Op)
	}
}

// resyncNews reconciles the news Redis keys with Postgres in one chunked pipeline.
// After this returns, every approved news row is in the cache, and every cache
// entry corresponds to an approved row.
func resyncNews(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	liveItems, err := db.AllNewsItems(ctx, pool)
	if err != nil {
		return fmt.Errorf("load news items: %w", err)
	}
	liveIDs := make(map[string]struct{}, len(liveItems))
	for _, it := range liveItems {
		liveIDs[strconv.Itoa(it.ID)] = struct{}{}
	}

	cacheIDs, err := rdb.ZRange(ctx, keyNewsByStart, 0, -1).Result()
	if err != nil {
		return fmt.Errorf("zrange: %w", err)
	}

	pipe := rdb.Pipeline()
	n := 0
	removed := 0
	for _, id := range cacheIDs {
		if _, ok := liveIDs[id]; !ok {
			pipe.HDel(ctx, keyNewsItems, id)
			pipe.ZRem(ctx, keyNewsByStart, id)
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
		pipe.HSet(ctx, keyNewsItems, id, data)
		pipe.ZAdd(ctx, keyNewsByStart, goredis.Z{Score: float64(it.StartDate.Unix()), Member: id})
		n++
		if pipe, err = flushIfFull(ctx, rdb, pipe, n); err != nil {
			return fmt.Errorf("pipeline exec: %w", err)
		}
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("pipeline exec: %w", err)
	}
	logger.Info("news cache resynced", "items", len(liveItems), "removed", removed)
	return nil
}
