package chat

import (
	"testing"
)

func beaconSet() map[int]Beacon {
	return map[int]Beacon{
		1: {ID: 1, Key: "first_impact", At: at("12:46"), PublicAt: at("12:51")},
		2: {ID: 2, Key: "second_impact", At: at("13:03"), PublicAt: at("13:03")},
	}
}

func phases() []Phase {
	one, two := 1, 2
	return []Phase{
		{ID: 10, ProfileID: 1, FromBeacon: nil, Tone: "ordinary morning", Sort: 0, Shock: 0},
		{ID: 11, ProfileID: 1, FromBeacon: &one, Tone: "confused", Sort: 1, Shock: 30},
		{ID: 12, ProfileID: 1, FromBeacon: &two, Tone: "frightened", Sort: 2, Shock: 80},
	}
}

func TestPhaseAtUsesPublicAtNotAt(t *testing.T) {
	// The north tower was struck at 12:46Z but was not on air until 12:51Z. A
	// buddy cannot react to an event they have not heard about, so the phase
	// must not advance until public_at.
	got, ok := PhaseAt(phases(), beaconSet(), at("12:48"))
	if !ok {
		t.Fatal("expected a phase")
	}
	if got.ID != 10 {
		t.Fatalf("phase %d at 12:48 — must still be the opening phase until public_at", got.ID)
	}

	got, _ = PhaseAt(phases(), beaconSet(), at("12:51"))
	if got.ID != 11 {
		t.Fatalf("phase %d at public_at — the beacon phase must be active from public_at inclusive", got.ID)
	}
}

func TestPhaseAtPicksTheLatestReachedBeacon(t *testing.T) {
	got, _ := PhaseAt(phases(), beaconSet(), at("14:00"))
	if got.ID != 12 {
		t.Fatalf("phase = %d, want 12 (both beacons passed)", got.ID)
	}
}

func TestPhaseAtBeforeAnyBeaconUsesTheNilBeaconPhase(t *testing.T) {
	got, ok := PhaseAt(phases(), beaconSet(), at("12:05"))
	if !ok || got.ID != 10 {
		t.Fatalf("got (%d, %v), want the FromBeacon=nil phase", got.ID, ok)
	}
}

func TestPhaseAtWithNoPhasesReturnsFalse(t *testing.T) {
	if _, ok := PhaseAt(nil, beaconSet(), at("14:00")); ok {
		t.Fatal("no phases configured must report false, not a zero Phase")
	}
}

func TestPhaseAtIgnoresAPhaseWhoseBeaconIsMissing(t *testing.T) {
	// A phase pointing at a deleted beacon must not silently win by sort order;
	// it is unresolvable and is skipped.
	ghost := 99
	ps := append(phases(), Phase{ID: 13, ProfileID: 1, FromBeacon: &ghost, Sort: 3})
	got, _ := PhaseAt(ps, beaconSet(), at("14:00"))
	if got.ID != 12 {
		t.Fatalf("phase = %d, want 12 — a phase with a missing beacon must be skipped", got.ID)
	}
}

func TestPhaseAtOutsideTheWindowStillResolves(t *testing.T) {
	// Availability gating is Gate's job, not PhaseAt's. Resolving a phase for a
	// time outside the chat window is legitimate — a seek can land anywhere.
	if _, ok := PhaseAt(phases(), beaconSet(), mustParse("2001-09-10T12:00:00Z")); !ok {
		t.Fatal("PhaseAt must resolve regardless of the chat window")
	}
}
