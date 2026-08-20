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

// opMp3Tags marks a notification that came from the tag tables rather than from
// mp3_items. It carries no id on purpose — see createMp3TagsNotifyFunctionSQL.
const opMp3Tags = "tags"

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

	// Tags live in two tables of their own — mp3_tags (the vocabulary) and
	// mp3_items_tags (the junction) — and until this existed, nothing anywhere
	// watched either. video-grabber's sync_item_tags rewrites junction rows
	// without touching mp3_items, so a tag rebuild changed what every card should
	// show and fired no NOTIFY at all: the metadata snapshot stayed stale until
	// the next process restart.
	//
	// A second function rather than reusing rt911_notify_mp3_items_change,
	// because that one publishes NEW.id — and on these tables that id is a tag
	// row or a junction row, not an mp3 item. Feeding it to the item-cache path
	// would have the listener look up an unrelated mp3_items row and act on it.
	// The op says "the tag graph moved, rebuild the corpus snapshot", which is
	// all a whole-corpus rebuild needs to know, so no id is published.
	createMp3TagsNotifyFunctionSQL = fmt.Sprintf(`
CREATE OR REPLACE FUNCTION rt911_notify_mp3_tags_change()
RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('%s', json_build_object('op', '%s')::text);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;`, mp3NotifyChannel, opMp3Tags)

	dropMp3TagsNotifyTriggerSQL = `DROP TRIGGER IF EXISTS rt911_mp3_tags_changed ON mp3_tags;`

	createMp3TagsNotifyTriggerSQL = `
CREATE TRIGGER rt911_mp3_tags_changed
AFTER INSERT OR UPDATE OR DELETE ON mp3_tags
FOR EACH ROW EXECUTE FUNCTION rt911_notify_mp3_tags_change();`

	dropMp3ItemsTagsNotifyTriggerSQL = `DROP TRIGGER IF EXISTS rt911_mp3_items_tags_changed ON mp3_items_tags;`

	createMp3ItemsTagsNotifyTriggerSQL = `
CREATE TRIGGER rt911_mp3_items_tags_changed
AFTER INSERT OR UPDATE OR DELETE ON mp3_items_tags
FOR EACH ROW EXECUTE FUNCTION rt911_notify_mp3_tags_change();`

	// Ordered: every CREATE TRIGGER is preceded by its own DROP … IF EXISTS, so
	// re-running the whole list on the next boot replaces rather than collides.
	mp3TriggerSQL = []string{
		createMp3NotifyFunctionSQL,
		dropMp3NotifyTriggerSQL,
		createMp3NotifyTriggerSQL,
		createMp3TagsNotifyFunctionSQL,
		dropMp3TagsNotifyTriggerSQL,
		createMp3TagsNotifyTriggerSQL,
		dropMp3ItemsTagsNotifyTriggerSQL,
		createMp3ItemsTagsNotifyTriggerSQL,
	}
)

// InstallMp3Triggers ensures the Postgres triggers and functions that fire NOTIFY
// on mp3_items, mp3_tags and mp3_items_tags changes are present. Idempotent —
// safe to call on every boot.
func InstallMp3Triggers(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	for _, q := range mp3TriggerSQL {
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
	// Scoped to this connection so the rebuilder goroutine below dies with it
	// rather than accumulating one per reconnect.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

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

	rebuild := startMp3MetaRebuilder(ctx, metaRebuildDebounce, func(c context.Context) error {
		return BuildMp3Meta(c, rdb, pool, logger)
	}, logger)

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

		if err := applyMp3Change(ctx, rdb, pool, change, rebuild); err != nil {
			logger.Warn("mp3 notify apply failed", "id", change.ID, "op", change.Op, "error", err)
		}
	}
}

func applyMp3Change(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, c changeNotification, rebuild *mp3MetaRebuilder) error {
	// Every one of these changes invalidates the metadata snapshot: mp3_items
	// carries the derived metadata columns themselves, and the tag tables carry
	// what the cards are tagged with. The snapshot is corpus-wide, so there is no
	// partial update to make — request a rebuild and let the debounce collapse a
	// burst of them.
	rebuild.request()

	switch c.Op {
	case opMp3Tags:
		// A vocabulary or junction row moved. No mp3_items row changed and the
		// payload deliberately carries no id, so the item cache stays out of it.
		return nil
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

// metaRebuildDebounce is how long a rebuild request waits for its neighbours.
//
// The rederive-mp3-metadata flow patches every one of the ~755 rows that has
// parties and then delete-inserts each one's junction rows, so a single offline
// rebuild produces thousands of notifications in a few minutes. Rebuilding per
// notification would re-read the whole corpus thousands of times to arrive at
// the same snapshot; coalescing turns the burst into a handful of rebuilds.
const metaRebuildDebounce = 2 * time.Second

// mp3MetaRebuilder serialises and coalesces metadata rebuilds behind a debounce,
// off the listener's goroutine so a slow rebuild never stalls the notification
// loop (and with it the item cache's own freshness).
type mp3MetaRebuilder struct {
	req chan struct{}
}

// request asks for a rebuild. Non-blocking and lossless: the channel holds one
// pending request, and a second request while one is already pending is
// redundant — both are asking for the same "rebuild everything".
func (r *mp3MetaRebuilder) request() {
	select {
	case r.req <- struct{}{}:
	default:
	}
}

// startMp3MetaRebuilder runs build in its own goroutine until ctx is done. build
// is injected rather than closed over here so the coalescing can be tested
// without a Postgres pool.
func startMp3MetaRebuilder(ctx context.Context, debounce time.Duration, build func(context.Context) error, logger *slog.Logger) *mp3MetaRebuilder {
	r := &mp3MetaRebuilder{req: make(chan struct{}, 1)}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-r.req:
			}
			// Let the rest of the burst land in the pending slot before reading
			// the corpus back, then rebuild once for all of it.
			select {
			case <-ctx.Done():
				return
			case <-time.After(debounce):
			}
			if err := build(ctx); err != nil && ctx.Err() == nil {
				logger.Warn("mp3 metadata rebuild failed", "error", err)
			}
		}
	}()
	return r
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

	// Rebuilt here rather than in a parallel rewarm path (hard rule #5): the
	// listener already owns "reconcile everything against Postgres on every
	// (re)connect", and the metadata snapshot has exactly the same recovery
	// problem — notifications dropped while disconnected are only recoverable by
	// rebuilding wholesale.
	warmMp3Meta(ctx, rdb, pool, logger)
	return nil
}
