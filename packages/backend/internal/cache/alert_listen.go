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

const alertNotifyChannel = "alert_items_changed"

var (
	createAlertNotifyFunctionSQL = fmt.Sprintf(`
CREATE OR REPLACE FUNCTION rt911_notify_alert_items_change()
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
$$ LANGUAGE plpgsql;`, alertNotifyChannel)

	dropAlertNotifyTriggerSQL = `DROP TRIGGER IF EXISTS rt911_alert_items_changed ON alert_items;`

	createAlertNotifyTriggerSQL = `
CREATE TRIGGER rt911_alert_items_changed
AFTER INSERT OR UPDATE OR DELETE ON alert_items
FOR EACH ROW EXECUTE FUNCTION rt911_notify_alert_items_change();`
)

// InstallAlertTriggers ensures the NOTIFY trigger on alert_items is present. Idempotent.
func InstallAlertTriggers(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	for _, q := range []string{createAlertNotifyFunctionSQL, dropAlertNotifyTriggerSQL, createAlertNotifyTriggerSQL} {
		if _, err := pool.Exec(ctx, q); err != nil {
			return fmt.Errorf("install alert triggers: %w", err)
		}
	}
	logger.Info("alert notify triggers installed", "channel", alertNotifyChannel)
	return nil
}

// ListenAlert keeps the alert Redis cache in sync with the DB for the process
// lifetime. Mirrors ListenNews: resync on every (re)connect, exponential backoff.
func ListenAlert(ctx context.Context, dsn string, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) {
	backoff := initialBackoff
	for {
		err := listenAlertOnce(ctx, dsn, rdb, pool, logger)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			logger.Warn("alert notify listener disconnected", "error", err, "retry_in", backoff)
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

func listenAlertOnce(ctx context.Context, dsn string, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer conn.Close(context.Background())

	if _, err := conn.Exec(ctx, "LISTEN "+alertNotifyChannel); err != nil {
		return fmt.Errorf("listen: %w", err)
	}

	if err := resyncAlert(ctx, rdb, pool, logger); err != nil {
		return fmt.Errorf("resync: %w", err)
	}
	logger.Info("alert notify listener attached", "channel", alertNotifyChannel)

	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		var change changeNotification
		if err := json.Unmarshal([]byte(n.Payload), &change); err != nil {
			logger.Warn("alert notify payload parse failed", "payload", n.Payload, "error", err)
			continue
		}
		if err := applyAlertChange(ctx, rdb, pool, change); err != nil {
			logger.Warn("alert notify apply failed", "id", change.ID, "op", change.Op, "error", err)
		}
	}
}

func applyAlertChange(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, c changeNotification) error {
	switch c.Op {
	case "delete":
		return ForgetAlert(ctx, rdb, c.ID)
	case "insert", "update":
		item, err := db.AlertItemByID(ctx, pool, c.ID)
		if err != nil {
			return err
		}
		if item == nil || item.Approved != 1 {
			return ForgetAlert(ctx, rdb, c.ID)
		}
		return UpsertAlert(ctx, rdb, *item)
	default:
		return fmt.Errorf("unknown op %q", c.Op)
	}
}

func resyncAlert(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	liveItems, err := db.AllAlertItems(ctx, pool)
	if err != nil {
		return fmt.Errorf("load alert items: %w", err)
	}
	liveIDs := make(map[string]struct{}, len(liveItems))
	for _, it := range liveItems {
		liveIDs[strconv.Itoa(it.ID)] = struct{}{}
	}

	cacheIDs, err := rdb.ZRange(ctx, keyAlertByStart, 0, -1).Result()
	if err != nil {
		return fmt.Errorf("zrange: %w", err)
	}

	pipe := rdb.Pipeline()
	n := 0
	removed := 0
	for _, id := range cacheIDs {
		if _, ok := liveIDs[id]; !ok {
			pipe.HDel(ctx, keyAlertItems, id)
			pipe.ZRem(ctx, keyAlertByStart, id)
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
		pipe.HSet(ctx, keyAlertItems, id, data)
		pipe.ZAdd(ctx, keyAlertByStart, goredis.Z{Score: float64(it.StartDate.Unix()), Member: id})
		n++
		if pipe, err = flushIfFull(ctx, rdb, pipe, n); err != nil {
			return fmt.Errorf("pipeline exec: %w", err)
		}
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("pipeline exec: %w", err)
	}
	logger.Info("alert cache resynced", "items", len(liveItems), "removed", removed)
	return nil
}
