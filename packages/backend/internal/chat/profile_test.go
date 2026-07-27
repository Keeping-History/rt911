package chat

import (
	"testing"
	"time"
)

func at(hhmm string) time.Time {
	t, err := time.Parse(time.RFC3339, "2001-09-11T"+hhmm+":00Z")
	if err != nil {
		panic(err)
	}
	return t
}

func ptr(t time.Time) *time.Time { return &t }

func TestProfileOnlineAt(t *testing.T) {
	tests := []struct {
		name string
		p    Profile
		when time.Time
		want bool
	}{
		{"no bounds is online across the whole window", Profile{}, at("14:00"), true},
		{"no bounds is offline before the window", Profile{}, at("11:59"), false},
		{"no bounds is offline at the window end", Profile{}, mustParse("2001-09-12T04:00:00Z"), false},
		{"no bounds is online at the window start", Profile{}, at("12:00"), true},
		{"after online_from", Profile{OnlineFrom: ptr(at("13:15"))}, at("13:16"), true},
		{"before online_from", Profile{OnlineFrom: ptr(at("13:15"))}, at("13:14"), false},
		{"exactly at online_from", Profile{OnlineFrom: ptr(at("13:15"))}, at("13:15"), true},
		{"before online_until", Profile{OnlineUntil: ptr(at("20:00"))}, at("19:59"), true},
		{"exactly at online_until is offline", Profile{OnlineUntil: ptr(at("20:00"))}, at("20:00"), false},
		{"inside both bounds", Profile{OnlineFrom: ptr(at("13:00")), OnlineUntil: ptr(at("15:00"))}, at("14:00"), true},
		{"outside both bounds", Profile{OnlineFrom: ptr(at("13:00")), OnlineUntil: ptr(at("15:00"))}, at("16:00"), false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.p.OnlineAt(tc.when); got != tc.want {
				t.Fatalf("OnlineAt(%s) = %v, want %v", tc.when.Format(time.RFC3339), got, tc.want)
			}
		})
	}
}

func mustParse(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestRosterCarriesProfileText(t *testing.T) {
	// Get Info needs student-facing prose. It must never fall back to Persona,
	// which is a second-person instruction to a model and would leak the
	// mechanism -- an empty profile is a curation gap, a leaked persona is a
	// broken illusion.
	got := Roster([]Profile{{
		ID: 1, ScreenName: "danny",
		Persona:     "You are Danny, 13, in eighth grade in Columbus.",
		ProfileText: "13. eighth grade. tony hawk pro skater 3 is the best game ever made.",
	}}, WindowStart.Add(time.Hour))

	if got[0].ProfileText != "13. eighth grade. tony hawk pro skater 3 is the best game ever made." {
		t.Errorf("ProfileText = %q", got[0].ProfileText)
	}
}

func TestRosterLeavesProfileTextEmptyRatherThanUsingPersona(t *testing.T) {
	got := Roster([]Profile{{ID: 1, ScreenName: "danny", Persona: "You are Danny."}},
		WindowStart.Add(time.Hour))

	if got[0].ProfileText != "" {
		t.Errorf("ProfileText must stay empty, got %q", got[0].ProfileText)
	}
}

func TestRosterPreservesSortAndMarksOnline(t *testing.T) {
	profiles := []Profile{
		{ID: 2, ScreenName: "skaterboi1988", Sort: 1, OnlineFrom: ptr(at("13:00"))},
		{ID: 5, ScreenName: "mom", Sort: 0},
	}
	got := Roster(profiles, at("12:30"))

	if len(got) != 2 {
		t.Fatalf("Roster length = %d, want 2", len(got))
	}
	if got[0].ScreenName != "mom" {
		t.Fatalf("Roster[0] = %q, want mom (lower sort first)", got[0].ScreenName)
	}
	if !got[0].Online {
		t.Fatal("mom should be online at 12:30")
	}
	if got[1].Online {
		t.Fatal("skaterboi1988 should be offline at 12:30 (online_from 13:00)")
	}
}
