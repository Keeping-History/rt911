package cache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"classicy/streamer/internal/db"
	"classicy/streamer/internal/model"

	"github.com/jackc/pgx/v5/pgxpool"
	goredis "github.com/redis/go-redis/v9"
)

// mp3 items reuse the MediaItem shape but live in their own Redis keyspace,
// separate from media:* and pager:*, so the default media tick path never
// scans them — they ride the opt-in "mp3" channel instead.
const (
	keyMp3Items   = "mp3:items"    // HASH  id → JSON
	keyMp3ByStart = "mp3:by_start" // ZSET  score=unix_start, member=id
)

// The Radio Traffic metadata and the tag vocabulary are whole-corpus, not
// time-sliced: there is no window to query them by, and nothing about them
// changes as a session's virtual clock moves. They therefore get their own keys
// alongside the item structures above, built once per warm/resync and read back
// whole, rather than being assembled per session or per request.
const (
	keyMp3Meta  = "mp3:meta"      // STRING — JSON map[id]model.ItemMeta
	keyMp3Vocab = "mp3:vocab"     // STRING — JSON []model.Tag
	keyMp3Etag  = "mp3:meta:etag" // STRING — content hash of the two above
)

// Mp3Meta is one build of the corpus-wide mp3 metadata: the id-keyed per-item
// metadata and the full tag vocabulary, already serialized, plus the stamp that
// identifies the build.
//
// The serialized bytes are what is held, not the decoded values, because the two
// transports want different things out of the same build: the mp3_meta frame
// needs Go values to msgpack, while the HTTP routes write JSON straight to the
// wire. Keeping both decoded forms resident would double ~1.5 MB for no reader,
// so each transport decodes only what it actually sends.
//
// Generation and ETag are the same content hash in two dresses. Content
// addressing rather than a per-process build id is load-bearing: the streamer
// runs N replicas, and a client that takes its vocabulary from one pod's HTTP
// route and its per-item tags from another pod's socket has to see the same
// stamp for the same data, or the mismatch check turns into a refetch loop.
type Mp3Meta struct {
	Generation string
	ETag       string
	ItemsJSON  []byte
	VocabJSON  []byte
}

// Items decodes the per-item metadata — what the one-shot mp3_meta frame sends.
func (m *Mp3Meta) Items() (map[int]model.ItemMeta, error) {
	var items map[int]model.ItemMeta
	if err := json.Unmarshal(m.ItemsJSON, &items); err != nil {
		return nil, fmt.Errorf("decode mp3 metadata: %w", err)
	}
	return items, nil
}

// Vocabulary decodes the tag vocabulary — what GET /mp3/tags serves.
func (m *Mp3Meta) Vocabulary() ([]model.Tag, error) {
	var vocab []model.Tag
	if err := json.Unmarshal(m.VocabJSON, &vocab); err != nil {
		return nil, fmt.Errorf("decode mp3 tag vocabulary: %w", err)
	}
	return vocab, nil
}

// AssembleMp3Meta serializes one build and stamps it with the hash of its own
// content. Pure — no Redis, no Postgres — so the stamp is reproducible from the
// inputs alone and every replica that reads the same rows produces the same one.
func AssembleMp3Meta(items map[int]model.ItemMeta, vocab []model.Tag) (*Mp3Meta, error) {
	itemsJSON, err := json.Marshal(items)
	if err != nil {
		return nil, fmt.Errorf("marshal mp3 metadata: %w", err)
	}
	vocabJSON, err := json.Marshal(vocab)
	if err != nil {
		return nil, fmt.Errorf("marshal mp3 tag vocabulary: %w", err)
	}

	// encoding/json emits map keys in sorted order, so the same corpus hashes to
	// the same value no matter what order Postgres returned the rows in.
	sum := sha256.New()
	sum.Write(itemsJSON)
	sum.Write(vocabJSON)
	generation := hex.EncodeToString(sum.Sum(nil))

	return &Mp3Meta{
		Generation: generation,
		ETag:       `"` + generation + `"`,
		ItemsJSON:  itemsJSON,
		VocabJSON:  vocabJSON,
	}, nil
}

// StoreMp3Meta writes a build to its three keys in one transaction, so a reader
// can never pair one build's items with another build's vocabulary or stamp.
func StoreMp3Meta(ctx context.Context, rdb *goredis.Client, m *Mp3Meta) error {
	pipe := rdb.TxPipeline()
	pipe.Set(ctx, keyMp3Meta, m.ItemsJSON, 0)
	pipe.Set(ctx, keyMp3Vocab, m.VocabJSON, 0)
	pipe.Set(ctx, keyMp3Etag, m.Generation, 0)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("store mp3 metadata: %w", err)
	}
	return nil
}

// LoadMp3Meta returns the current build, or nil when none has been stored yet.
//
// Nil rather than an empty build: a session that subscribes before the first
// warm completes should get no mp3_meta frame at all and stay without metadata
// until it reconnects, rather than be handed an empty corpus it would cache as
// the truth for the rest of its life. The frame is one-shot — there is no second
// chance to correct it.
func LoadMp3Meta(ctx context.Context, rdb *goredis.Client) (*Mp3Meta, error) {
	vals, err := rdb.MGet(ctx, keyMp3Meta, keyMp3Vocab, keyMp3Etag).Result()
	if err != nil {
		return nil, fmt.Errorf("read mp3 metadata: %w", err)
	}
	parts := make([]string, len(vals))
	for i, v := range vals {
		s, ok := v.(string)
		if !ok {
			return nil, nil
		}
		parts[i] = s
	}
	return &Mp3Meta{
		Generation: parts[2],
		ETag:       `"` + parts[2] + `"`,
		ItemsJSON:  []byte(parts[0]),
		VocabJSON:  []byte(parts[1]),
	}, nil
}

// Mp3MetaGeneration returns the stamp of the current build, or "" when none has
// been stored yet.
//
// It exists so a reader can ask "is what I already hold still current?" for the
// cost of one small GET. LoadMp3Meta drags ~1.5 MB across the wire, which is the
// right price to pay once per build and the wrong price to pay per HTTP request:
// the metadata routes hold their composed response bytes in process and only
// reload when this stamp moves.
func Mp3MetaGeneration(ctx context.Context, rdb *goredis.Client) (string, error) {
	gen, err := rdb.Get(ctx, keyMp3Etag).Result()
	if err == goredis.Nil {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read mp3 metadata generation: %w", err)
	}
	return gen, nil
}

// BuildMp3Meta reads the metadata and the vocabulary from Postgres, assembles a
// build and stores it. Two queries and a whole-corpus rewrite every time: the
// snapshot is corpus-wide, so there is no such thing as updating one item's
// share of it. That is affordable because it runs on warm, on listener resync
// and behind the debounce in mp3_listen.go — never on a tick and never per request.
func BuildMp3Meta(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	items, err := db.Mp3Metadata(ctx, pool)
	if err != nil {
		return fmt.Errorf("load mp3 metadata: %w", err)
	}
	vocab, err := db.Mp3TagVocabulary(ctx, pool)
	if err != nil {
		return fmt.Errorf("load mp3 tag vocabulary: %w", err)
	}
	m, err := AssembleMp3Meta(items, vocab)
	if err != nil {
		return err
	}
	if err := StoreMp3Meta(ctx, rdb, m); err != nil {
		return err
	}
	logger.Info("mp3 metadata snapshot built",
		"items", len(items), "tags", len(vocab), "generation", m.Generation)
	return nil
}

// WarmMp3Cache loads all approved mp3 items from PostgreSQL into Redis if not
// already present, then builds the metadata snapshot if it is missing.
func WarmMp3Cache(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	if err := warmMp3Items(ctx, rdb, pool, logger); err != nil {
		return err
	}
	// Checked separately from the item keys: an items cache left warm by a
	// previous process says nothing about whether the metadata was ever built —
	// before this change nothing built it at all, so every existing deployment
	// arrives here warm on items and empty on metadata.
	n, err := rdb.Exists(ctx, keyMp3Meta).Result()
	if err == nil && n == 1 {
		return nil
	}
	warmMp3Meta(ctx, rdb, pool, logger)
	return nil
}

// warmMp3Meta builds the metadata snapshot, logging rather than returning a
// failure.
//
// The metadata columns are applied to the schema by a separate infra PR, on its
// own release cadence, so an image can legitimately reach a database that has
// mp3_items but not mp3_items.participants yet. Propagating that error would
// abort the mp3 warm and disable the whole radio channel over metadata that only
// decorates it — the same reasoning that makes the mp3 channel itself non-fatal
// in cmd/server/main.go, one level down. Cards degrade to title and transcript;
// audio keeps streaming.
func warmMp3Meta(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) {
	if err := BuildMp3Meta(ctx, rdb, pool, logger); err != nil {
		logger.Warn("mp3 metadata snapshot build failed; radio cards degrade to title only", "error", err)
	}
}

func warmMp3Items(ctx context.Context, rdb *goredis.Client, pool *pgxpool.Pool, logger *slog.Logger) error {
	n, err := rdb.ZCard(ctx, keyMp3ByStart).Result()
	if err == nil && n > 0 {
		logger.Info("mp3 cache already warm", "items", n)
		return nil
	}

	logger.Info("warming mp3 cache from database…")
	items, err := db.AllMp3Items(ctx, pool)
	if err != nil {
		return fmt.Errorf("load mp3 items: %w", err)
	}

	pipe := rdb.Pipeline()
	count := 0
	for _, it := range items {
		data, err := json.Marshal(it)
		if err != nil {
			continue
		}
		id := strconv.Itoa(it.ID)
		pipe.HSet(ctx, keyMp3Items, id, data)
		pipe.ZAdd(ctx, keyMp3ByStart, goredis.Z{
			Score:  float64(it.StartDate.Unix()),
			Member: id,
		})
		count++
		if pipe, err = flushIfFull(ctx, rdb, pipe, count); err != nil {
			return fmt.Errorf("pipeline exec: %w", err)
		}
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("pipeline exec: %w", err)
	}

	logger.Info("mp3 cache warm", "items", len(items))
	return nil
}

// UpsertMp3 stores a single mp3 item in the cache, overwriting any existing
// entry. Used by the NOTIFY listener to apply INSERT/UPDATE events incrementally.
func UpsertMp3(ctx context.Context, rdb *goredis.Client, it model.MediaItem) error {
	data, err := json.Marshal(it)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	id := strconv.Itoa(it.ID)
	pipe := rdb.Pipeline()
	pipe.HSet(ctx, keyMp3Items, id, data)
	pipe.ZAdd(ctx, keyMp3ByStart, goredis.Z{
		Score:  float64(it.StartDate.Unix()),
		Member: id,
	})
	_, err = pipe.Exec(ctx)
	return err
}

// ForgetMp3 removes an mp3 item from the cache. Used by the NOTIFY listener to
// apply DELETE events and to evict rows whose approved flag flipped to 0.
func ForgetMp3(ctx context.Context, rdb *goredis.Client, id int) error {
	sid := strconv.Itoa(id)
	pipe := rdb.Pipeline()
	pipe.HDel(ctx, keyMp3Items, sid)
	pipe.ZRem(ctx, keyMp3ByStart, sid)
	_, err := pipe.Exec(ctx)
	return err
}

// Mp3ItemsAt returns mp3 items whose start_date Unix-second exactly equals
// t.Unix().
func Mp3ItemsAt(ctx context.Context, rdb *goredis.Client, t time.Time) ([]model.MediaItem, error) {
	lo := float64(t.Unix())
	hi := lo

	ids, err := rdb.ZRangeByScore(ctx, keyMp3ByStart, &goredis.ZRangeBy{
		Min: strconv.FormatFloat(lo, 'f', 0, 64),
		Max: strconv.FormatFloat(hi, 'f', 0, 64),
	}).Result()
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	return fetchMp3ByIDs(ctx, rdb, ids)
}

// Mp3ItemsInRange returns mp3 items whose start_date Unix-second is in the
// half-open interval [lo, hi). The windowing refill path queries forward windows
// with this; recordings already playing at the window's lower edge are covered by
// the init/seek/subscribe overlap snapshot (CurrentMp3Items), not here.
func Mp3ItemsInRange(ctx context.Context, rdb *goredis.Client, lo, hi time.Time) ([]model.MediaItem, error) {
	ids, err := rdb.ZRangeByScore(ctx, keyMp3ByStart, &goredis.ZRangeBy{
		Min: strconv.FormatInt(lo.Unix(), 10),
		Max: "(" + strconv.FormatInt(hi.Unix(), 10), // exclusive upper bound
	}).Result()
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	return fetchMp3ByIDs(ctx, rdb, ids)
}

func fetchMp3ByIDs(ctx context.Context, rdb *goredis.Client, ids []string) ([]model.MediaItem, error) {
	vals, err := rdb.HMGet(ctx, keyMp3Items, ids...).Result()
	if err != nil {
		return nil, err
	}
	items := make([]model.MediaItem, 0, len(vals))
	for _, v := range vals {
		if v == nil {
			continue
		}
		var it model.MediaItem
		if err := json.Unmarshal([]byte(v.(string)), &it); err == nil {
			items = append(items, it)
		}
	}
	return items, nil
}
