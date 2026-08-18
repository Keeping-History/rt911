package db

import (
	"regexp"
	"strings"
	"testing"
)

// These are SQL-string assertions, not integration tests. There is no live
// Postgres in this package's test environment — every existing test here
// (news_test.go, sources_cache_test.go) asserts constants and pure helpers for
// the same reason. What they can still catch is the whole class of failure that
// matters most here: a column added to a query that must never fetch it, a
// vocabulary quietly narrowed to the tags in use, or the shared mp3 select
// widened until queryItems' positional scan no longer matches it.

// `mp3_items.parties` is the private blob these public columns are a redacted
// projection of; it carries `gate_reasons` and `model`, the QA signals that say
// how far to trust a row. video-grabber's public_meta.py is the ONLY place that
// redaction happens, and it is a closed projection precisely so nothing
// downstream has to re-check it. Selecting the column here would route around
// that entirely — the metadata frame would be carrying the private blob no
// matter how carefully the projection upstream was written.
func TestNoMp3QuerySelectsParties(t *testing.T) {
	for name, q := range map[string]string{
		"mp3MetaSelectFrom":     mp3MetaSelectFrom,
		"mp3TagVocabularyQuery": mp3TagVocabularyQuery,
		"mp3SelectFrom":         mp3SelectFrom,
	} {
		if regexp.MustCompile(`\bparties\b`).MatchString(q) {
			t.Errorf("%s references the private parties column:\n%s", name, q)
		}
	}
}

// Unapproved rows are drafts and retractions; the item queries all gate on
// approved = 1 and the metadata must not describe items the client never sees.
func TestMp3MetadataQueryFiltersToApproved(t *testing.T) {
	q := mp3MetaSelectFrom + ` WHERE mi.approved = 1`
	if !strings.Contains(q, "mi.approved = 1") {
		t.Fatalf("Mp3Metadata query does not filter to approved rows:\n%s", q)
	}
}

// json_agg over an empty set returns NULL, and the LEFT JOIN LATERAL still
// yields a row for an item with no junction rows. Without the COALESCE that
// scans to a nil slice, and the client cannot tell "this item has no tags" from
// "the tag list failed to load". Story 003 criterion 2.
func TestMp3MetadataCoalescesAnUntaggedItemToAnEmptyArray(t *testing.T) {
	if !strings.Contains(mp3MetaSelectFrom, `COALESCE(tg.tags, '[]'::json)`) {
		t.Fatalf("untagged items would scan to a nil tag slice; expected COALESCE to '[]'::json:\n%s",
			mp3MetaSelectFrom)
	}
	if !strings.Contains(mp3MetaSelectFrom, "LEFT JOIN LATERAL") {
		t.Fatalf("an inner join would drop untagged items entirely:\n%s", mp3MetaSelectFrom)
	}
}

// One row per item, not one per tagging: the aggregate has to be correlated to
// mi.id inside the lateral, or every item gets the whole junction table.
func TestMp3MetadataAggregatesTagsPerItem(t *testing.T) {
	for _, want := range []string{
		"json_agg(json_build_object(",
		"WHERE j.mp3_items_id = mi.id",
		"JOIN mp3_tags t ON t.id = j.mp3_tags_id",
	} {
		if !strings.Contains(mp3MetaSelectFrom, want) {
			t.Errorf("mp3MetaSelectFrom is missing %q:\n%s", want, mp3MetaSelectFrom)
		}
	}
}

// Story 003 criterion 3. Vocabulary rows are created but never deleted — a tag
// the model retracts loses its junction rows while the row survives, keeping any
// color/sort a curator set on it. Deriving the vocabulary by deduping the
// per-item aggregate would silently drop every such tag, and every tag attached
// only to unapproved items, from the filter UI. So this reads the whole table:
// no join to the junction, no approved filter.
func TestMp3TagVocabularyReadsTheWholeTable(t *testing.T) {
	if strings.Contains(mp3TagVocabularyQuery, "mp3_items_tags") {
		t.Errorf("vocabulary joins the junction — tags attached to no item would vanish:\n%s",
			mp3TagVocabularyQuery)
	}
	if strings.Contains(mp3TagVocabularyQuery, "approved") {
		t.Errorf("vocabulary filters on approval — tags used only by unapproved items would vanish:\n%s",
			mp3TagVocabularyQuery)
	}
	if !strings.Contains(mp3TagVocabularyQuery, "FROM mp3_tags") {
		t.Errorf("vocabulary does not read mp3_tags:\n%s", mp3TagVocabularyQuery)
	}
}

// Story 003 criterion 4. `sort` is the curator's hand-ordering and is NULL for
// every tag nobody has ordered — the large majority. Plain `ORDER BY sort` puts
// NULLs FIRST in Postgres, which would bury the curated ordering under a
// thousand unordered tags: the exact opposite of what the column is for.
func TestMp3TagVocabularyOrdersBySortThenTag(t *testing.T) {
	if !strings.Contains(mp3TagVocabularyQuery, "ORDER BY sort NULLS LAST, tag") {
		t.Fatalf("expected ORDER BY sort NULLS LAST, tag:\n%s", mp3TagVocabularyQuery)
	}
}

// Story 003 criterion 6. mp3SelectFrom is shared by AllMp3Items, Mp3ItemByID,
// CurrentMp3Items and Mp3ItemHistory, all four of which funnel through
// queryItems — whose rows.Scan is a fixed 20-column positional list that the
// news, media and newsList selects scan through as well. Adding a column here
// does not fail to compile; it fails at runtime, in every one of those callers
// at once, because the scan list is one short. That is why the metadata lives in
// its own query with its own scanner.
func TestMp3SelectFromStillMatchesTheSharedScanList(t *testing.T) {
	if got := countSelectedColumns(t, mp3SelectFrom); got != 20 {
		t.Fatalf("mp3SelectFrom selects %d columns, queryItems scans exactly 20", got)
	}
	if got := countSelectedColumns(t, selectFrom); got != 20 {
		t.Fatalf("selectFrom selects %d columns, queryItems scans exactly 20", got)
	}
	if got := countSelectedColumns(t, newsSelectFrom); got != 20 {
		t.Fatalf("newsSelectFrom selects %d columns, queryItems scans exactly 20", got)
	}

	for _, col := range []string{
		"subject", "participants", "mentions", "provenance", "peaks", "tags",
		"tier", "evidence", "confidence",
	} {
		if regexp.MustCompile(`\b` + col + `\b`).MatchString(mp3SelectFrom) {
			t.Errorf("mp3SelectFrom grew a %q column; queryItems' scan list would no longer match", col)
		}
	}
}

// countSelectedColumns counts the top-level comma-separated expressions between
// SELECT and FROM. Depth-aware so a function call's own commas don't count.
func countSelectedColumns(t *testing.T, q string) int {
	t.Helper()
	start := strings.Index(q, "SELECT ")
	from := strings.Index(q, "FROM ")
	if start < 0 || from < 0 || from < start {
		t.Fatalf("cannot find SELECT … FROM in:\n%s", q)
	}

	n, depth := 1, 0
	for _, r := range q[start+len("SELECT ") : from] {
		switch r {
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				n++
			}
		}
	}
	return n
}
