package cache

import (
	"context"
	"strings"
	"testing"
	"time"

	"classicy/streamer/internal/model"
)

func sampleMeta() (map[int]model.ItemMeta, []model.Tag) {
	items := map[int]model.ItemMeta{
		5821: {
			Subject: "Boston Center coordinates with NEADS",
			Tier:    "primary",
			Tags:    []model.Tag{{Tag: "facility:zbw", Namespace: "facility", Value: "ZBW"}},
			Peaks:   [][2]int8{{-3, 3}, {-12, 10}},
		},
		5822: {Subject: "NEADS scramble order", Tags: []model.Tag{}},
	}
	vocab := []model.Tag{
		{Tag: "facility:zbw", Namespace: "facility", Value: "ZBW"},
		{Tag: "topic:scramble", Namespace: "topic", Value: "Scramble"},
	}
	return items, vocab
}

// The generation is the stamp a client compares its cached vocabulary against.
// Deriving it from the content rather than from the process is what lets a
// client take its vocabulary from one replica's HTTP route and its item tags
// from another replica's socket without seeing a spurious mismatch.
func TestAssembleMp3MetaStampsTheSameContentIdentically(t *testing.T) {
	items, vocab := sampleMeta()

	a, err := AssembleMp3Meta(items, vocab)
	if err != nil {
		t.Fatalf("AssembleMp3Meta: %v", err)
	}
	b, err := AssembleMp3Meta(items, vocab)
	if err != nil {
		t.Fatalf("AssembleMp3Meta: %v", err)
	}
	if a.Generation != b.Generation {
		t.Fatalf("same corpus produced two generations: %q vs %q", a.Generation, b.Generation)
	}
	if a.Generation == "" {
		t.Fatal("generation is empty")
	}
	if a.ETag != `"`+a.Generation+`"` {
		t.Fatalf("ETag %q is not the quoted generation %q", a.ETag, a.Generation)
	}
}

// A tag rebuild that only rewrites junction rows still has to move the stamp —
// otherwise a client holding the previous build has no way to notice.
func TestAssembleMp3MetaStampMovesWhenTagsChange(t *testing.T) {
	items, vocab := sampleMeta()
	before, err := AssembleMp3Meta(items, vocab)
	if err != nil {
		t.Fatalf("AssembleMp3Meta: %v", err)
	}

	items[5822] = model.ItemMeta{
		Subject: "NEADS scramble order",
		Tags:    []model.Tag{{Tag: "topic:scramble", Namespace: "topic", Value: "Scramble"}},
	}
	after, err := AssembleMp3Meta(items, vocab)
	if err != nil {
		t.Fatalf("AssembleMp3Meta: %v", err)
	}

	if before.Generation == after.Generation {
		t.Fatal("attaching a tag to an item left the generation unchanged")
	}
}

// The vocabulary is a corpus of its own: a curator adding a tag nothing is
// attached to yet still changes what the filter tree must offer.
func TestAssembleMp3MetaStampMovesWhenOnlyTheVocabularyChanges(t *testing.T) {
	items, vocab := sampleMeta()
	before, err := AssembleMp3Meta(items, vocab)
	if err != nil {
		t.Fatalf("AssembleMp3Meta: %v", err)
	}
	after, err := AssembleMp3Meta(items, append(vocab, model.Tag{
		Tag: "topic:evacuation", Namespace: "topic", Value: "Evacuation",
	}))
	if err != nil {
		t.Fatalf("AssembleMp3Meta: %v", err)
	}
	if before.Generation == after.Generation {
		t.Fatal("adding a vocabulary row left the generation unchanged")
	}
}

func TestStoreAndLoadMp3MetaRoundTrip(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	items, vocab := sampleMeta()
	built, err := AssembleMp3Meta(items, vocab)
	if err != nil {
		t.Fatalf("AssembleMp3Meta: %v", err)
	}
	if err := StoreMp3Meta(ctx, rdb, built); err != nil {
		t.Fatalf("StoreMp3Meta: %v", err)
	}

	loaded, err := LoadMp3Meta(ctx, rdb)
	if err != nil {
		t.Fatalf("LoadMp3Meta: %v", err)
	}
	if loaded == nil {
		t.Fatal("LoadMp3Meta returned nil after a store")
	}
	if loaded.Generation != built.Generation || loaded.ETag != built.ETag {
		t.Fatalf("stamp did not survive Redis: got %q/%q want %q/%q",
			loaded.Generation, loaded.ETag, built.Generation, built.ETag)
	}

	gotItems, err := loaded.Items()
	if err != nil {
		t.Fatalf("Items: %v", err)
	}
	if len(gotItems) != 2 {
		t.Fatalf("expected 2 items, got %d", len(gotItems))
	}
	if gotItems[5821].Subject != "Boston Center coordinates with NEADS" {
		t.Fatalf("item 5821 subject lost: %+v", gotItems[5821])
	}
	if got := gotItems[5821].Peaks; len(got) != 2 || got[1] != [2]int8{-12, 10} {
		t.Fatalf("peaks did not survive: %+v", got)
	}
	// An untagged item must come back with an empty list, not a missing field —
	// the client has to be able to tell "nothing is tagged" from "no metadata".
	if gotItems[5822].Tags == nil || len(gotItems[5822].Tags) != 0 {
		t.Fatalf("expected an empty tag list on the untagged item, got %+v", gotItems[5822].Tags)
	}

	gotVocab, err := loaded.Vocabulary()
	if err != nil {
		t.Fatalf("Vocabulary: %v", err)
	}
	if len(gotVocab) != 2 || gotVocab[1].Value != "Scramble" {
		t.Fatalf("vocabulary did not survive: %+v", gotVocab)
	}
}

// Nil, not an empty build: the mp3_meta frame is one-shot, so a session handed
// an empty corpus would hold it as the truth until it reconnects.
func TestLoadMp3MetaReturnsNilBeforeAnyBuild(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()

	got, err := LoadMp3Meta(context.Background(), rdb)
	if err != nil {
		t.Fatalf("LoadMp3Meta: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil before any build, got %+v", got)
	}
}

// The metadata snapshot is whole-corpus while the item cache is time-sliced;
// they share a prefix and nothing else. A write to either must be invisible to
// the other's readers.
func TestMp3MetaKeysAreSeparateFromTheItemCache(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx := context.Background()

	start := time.Date(2001, 9, 11, 15, 26, 0, 0, time.UTC)
	if err := UpsertMp3(ctx, rdb, model.MediaItem{
		ID: 5821, Title: "ID Rountree", Format: "mp3", Approved: 1, StartDate: start,
	}); err != nil {
		t.Fatalf("UpsertMp3: %v", err)
	}

	items, vocab := sampleMeta()
	built, err := AssembleMp3Meta(items, vocab)
	if err != nil {
		t.Fatalf("AssembleMp3Meta: %v", err)
	}
	if err := StoreMp3Meta(ctx, rdb, built); err != nil {
		t.Fatalf("StoreMp3Meta: %v", err)
	}

	got, err := Mp3ItemsAt(ctx, rdb, start)
	if err != nil {
		t.Fatalf("Mp3ItemsAt: %v", err)
	}
	if len(got) != 1 || got[0].ID != 5821 {
		t.Fatalf("the metadata snapshot disturbed the item lookup: %+v", got)
	}

	if err := ForgetMp3(ctx, rdb, 5821); err != nil {
		t.Fatalf("ForgetMp3: %v", err)
	}
	meta, err := LoadMp3Meta(ctx, rdb)
	if err != nil || meta == nil {
		t.Fatalf("evicting an item destroyed the metadata snapshot: %+v, %v", meta, err)
	}
}

// Until this shipped, the only NOTIFY trigger was on mp3_items. video-grabber's
// sync_item_tags rewrites junction rows without touching mp3_items, so a tag
// rebuild changed every card's chips and fired nothing at all.
func TestInstallMp3TriggersCoversTheTagTables(t *testing.T) {
	all := strings.Join(mp3TriggerSQL, "\n")

	for _, table := range []string{"mp3_items", "mp3_tags", "mp3_items_tags"} {
		if !strings.Contains(all, "ON "+table+"\n") {
			t.Errorf("no AFTER INSERT OR UPDATE OR DELETE trigger on %s", table)
		}
	}

	// Every trigger created must be dropped first, or the second boot fails on a
	// duplicate object. InstallMp3Triggers runs on every start.
	for _, trigger := range []string{
		"rt911_mp3_items_changed", "rt911_mp3_tags_changed", "rt911_mp3_items_tags_changed",
	} {
		drop := "DROP TRIGGER IF EXISTS " + trigger
		create := "CREATE TRIGGER " + trigger
		di, ci := strings.Index(all, drop), strings.Index(all, create)
		if di < 0 {
			t.Errorf("%s is created but never dropped first", trigger)
			continue
		}
		if ci < 0 || di > ci {
			t.Errorf("%s is dropped after it is created", trigger)
		}
	}

	// The tag tables must not reuse the item function: it publishes NEW.id, and
	// on those tables that id is a vocabulary or junction row, not an mp3 item.
	if !strings.Contains(all, "rt911_notify_mp3_tags_change()") {
		t.Error("the tag tables do not have their own notify function")
	}
	if strings.Contains(all, "ON mp3_tags\nFOR EACH ROW EXECUTE FUNCTION rt911_notify_mp3_items_change()") {
		t.Error("mp3_tags reuses the item notify function, which would publish a tag id as an item id")
	}
}

// The junction trigger's whole reason to exist: a tag rebuild has to invalidate
// the snapshot. It must do so without the item cache acting on an id that is not
// an mp3 item's.
func TestJunctionWriteRebuildsMetadataWithoutTouchingTheItemCache(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	start := time.Date(2001, 9, 11, 15, 26, 0, 0, time.UTC)
	if err := UpsertMp3(ctx, rdb, model.MediaItem{
		ID: 42, Title: "ID Rountree", Format: "mp3", Approved: 1, StartDate: start,
	}); err != nil {
		t.Fatalf("UpsertMp3: %v", err)
	}

	built := make(chan struct{}, 4)
	rebuild := startMp3MetaRebuilder(ctx, 0, func(context.Context) error {
		built <- struct{}{}
		return nil
	}, discardLogger())

	// The payload the junction trigger sends: an op and no id. A nil pool proves
	// this path never reaches Postgres for an item row.
	if err := applyMp3Change(ctx, rdb, nil, changeNotification{Op: opMp3Tags}, rebuild); err != nil {
		t.Fatalf("applyMp3Change: %v", err)
	}

	select {
	case <-built:
	case <-time.After(2 * time.Second):
		t.Fatal("a junction-row write did not invalidate the metadata snapshot")
	}

	got, err := Mp3ItemsAt(ctx, rdb, start)
	if err != nil {
		t.Fatalf("Mp3ItemsAt: %v", err)
	}
	if len(got) != 1 || got[0].ID != 42 {
		t.Fatalf("a tag notification disturbed the item cache: %+v", got)
	}
}

// mp3_items carries the derived metadata columns themselves, so its own changes
// invalidate the snapshot too — the junction trigger widens the coverage, it
// does not replace it.
func TestItemChangeAlsoRebuildsMetadata(t *testing.T) {
	rdb, done := newTestRedis(t)
	defer done()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	built := make(chan struct{}, 4)
	rebuild := startMp3MetaRebuilder(ctx, 0, func(context.Context) error {
		built <- struct{}{}
		return nil
	}, discardLogger())

	if err := applyMp3Change(ctx, rdb, nil, changeNotification{Op: "delete", ID: 42}, rebuild); err != nil {
		t.Fatalf("applyMp3Change: %v", err)
	}
	select {
	case <-built:
	case <-time.After(2 * time.Second):
		t.Fatal("an mp3_items change did not invalidate the metadata snapshot")
	}
}

// The rederive flow patches ~755 rows and delete-inserts each one's junction
// rows, so one offline rebuild produces thousands of notifications. Rebuilding
// per notification would re-read the whole corpus once per row to reach the same
// snapshot.
func TestMetaRebuilderCoalescesABurst(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	release := make(chan struct{})
	built := make(chan struct{}, 200)
	rebuild := startMp3MetaRebuilder(ctx, time.Millisecond, func(context.Context) error {
		built <- struct{}{}
		<-release
		return nil
	}, discardLogger())

	for range 100 {
		rebuild.request()
	}
	// Let the first rebuild start and the rest of the burst pile up behind it.
	select {
	case <-built:
	case <-time.After(2 * time.Second):
		t.Fatal("the first rebuild never started")
	}
	close(release)

	// The burst must collapse into at most one more rebuild — the pending slot
	// holds one request, not one per notification.
	time.Sleep(100 * time.Millisecond)
	if n := len(built); n > 1 {
		t.Fatalf("100 requests produced %d further rebuilds, expected at most 1", n+1)
	}
}

// A request that arrives while a rebuild is running must still be honoured, or a
// change landing mid-rebuild would be lost until the next listener reconnect.
func TestMetaRebuilderRunsAgainForAChangeDuringARebuild(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	started := make(chan struct{}, 4)
	release := make(chan struct{})
	rebuild := startMp3MetaRebuilder(ctx, 0, func(context.Context) error {
		started <- struct{}{}
		<-release
		return nil
	}, discardLogger())

	rebuild.request()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("the first rebuild never started")
	}

	rebuild.request()
	close(release)

	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("a request made during a rebuild was dropped")
	}
}
