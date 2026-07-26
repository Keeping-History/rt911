package chat

import "testing"

func TestFireAtResolvesBeaconPlusOffsetOnPublicAt(t *testing.T) {
	// Beats anchor to public_at for the same reason phases do: a buddy cannot
	// react to an event before it was knowable.
	b := map[int]Beacon{1: {ID: 1, At: at("12:46"), PublicAt: at("12:51")}}
	id := 1
	got, ok := Schedule{AtBeacon: &id, OffsetSeconds: 120}.FireAt(b)

	if !ok || !got.Equal(at("12:53")) {
		t.Errorf("FireAt = %v (ok=%v), want 12:53", got, ok)
	}
}

func TestAbsoluteAtOverridesTheBeacon(t *testing.T) {
	b := map[int]Beacon{1: {ID: 1, PublicAt: at("12:51")}}
	id := 1
	abs := at("13:30")
	got, ok := Schedule{AtBeacon: &id, OffsetSeconds: 120, At: &abs}.FireAt(b)

	if !ok || !got.Equal(abs) {
		t.Errorf("absolute At must win, got %v", got)
	}
}

func TestDueBetweenIsHalfOpenSoNoBeatFiresTwice(t *testing.T) {
	b := map[int]Beacon{1: {ID: 1, PublicAt: at("12:51")}}
	id := 1
	s := []Schedule{{ID: 9, AtBeacon: &id}}

	if got := DueBetween(s, b, at("12:50"), at("12:51")); len(got) != 1 {
		t.Errorf("beat at the window end must fire once, got %d", len(got))
	}
	if got := DueBetween(s, b, at("12:51"), at("12:52")); len(got) != 0 {
		t.Errorf("same beat must not fire again in the next window, got %d", len(got))
	}
}

func TestScheduleWithAMissingBeaconDoesNotFire(t *testing.T) {
	id := 99
	if _, ok := (Schedule{AtBeacon: &id}).FireAt(map[int]Beacon{}); ok {
		t.Error("a schedule pointing at a deleted beacon must not fire")
	}
}
