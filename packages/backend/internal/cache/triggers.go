package cache

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The trigger and function names are rt911_-prefixed so they cannot collide
// with anything Directus or another tenant might install on the same table.
var (
	createNotifyFunctionSQL = fmt.Sprintf(`
CREATE OR REPLACE FUNCTION rt911_notify_media_items_change()
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
$$ LANGUAGE plpgsql;`, notifyChannel)

	dropNotifyTriggerSQL = `DROP TRIGGER IF EXISTS rt911_media_items_changed ON media_items;`

	createNotifyTriggerSQL = `
CREATE TRIGGER rt911_media_items_changed
AFTER INSERT OR UPDATE OR DELETE ON media_items
FOR EACH ROW EXECUTE FUNCTION rt911_notify_media_items_change();`
)

// InstallTriggers ensures the Postgres trigger and function that fire
// NOTIFY on media_items changes are present. Idempotent — safe to call on
// every boot.
func InstallTriggers(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) error {
	for _, q := range []string{createNotifyFunctionSQL, dropNotifyTriggerSQL, createNotifyTriggerSQL} {
		if _, err := pool.Exec(ctx, q); err != nil {
			return fmt.Errorf("install triggers: %w", err)
		}
	}
	logger.Info("notify triggers installed", "channel", notifyChannel)
	return nil
}
