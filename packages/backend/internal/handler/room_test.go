package handler

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"classicy/streamer/internal/db"
	"classicy/streamer/internal/fanout"
	"classicy/streamer/internal/model"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"
)

// A nil pool is deliberate: every case using this helper must be rejected
// before the handler reaches the session or ownership lookup, and a nil pool
// panicking is what proves it.
//
// The authorised path needs Directus tables, so it is not exercised end to end
// here. It is pinned instead by the two tests at the bottom: mayDriveRoom for
// the decision, and the query-shape assertion for what the decision is fed.
func newRoomTestHandler(t *testing.T) http.HandlerFunc {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	t.Cleanup(mr.Close)
	rdb := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	bus := fanout.New[model.RoomCommand](rdb, "room:command", logger)
	return NewRoomHandler(nil, bus, NewOriginAllowlist(""), logger)
}

func roomPost(t *testing.T, h http.HandlerFunc, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("POST", "/room", strings.NewReader(body))
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

func TestRoomControlRejectsNonPost(t *testing.T) {
	r := httptest.NewRequest("GET", "/room", nil)
	w := httptest.NewRecorder()
	newRoomTestHandler(t)(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", w.Code)
	}
}

// The session cookie is SameSite=lax, which bounds it to the site rather than
// the origin — so without this any page under 911realtime.org could drive a
// signed-in teacher's classroom on their behalf.
func TestRoomControlRejectsAnUntrustedOrigin(t *testing.T) {
	r := httptest.NewRequest("POST", "/room", strings.NewReader(`{"room":"42","action":"message","message":"hi"}`))
	r.Header.Set("Origin", "https://archived-third-party.911realtime.org")
	w := httptest.NewRecorder()
	newRoomTestHandler(t)(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestRoomControlRequiresARoom(t *testing.T) {
	w := roomPost(t, newRoomTestHandler(t), `{"action":"message","message":"hi"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

// An unknown action must fail at this boundary. Forwarded, it would reach
// clients that silently ignore it, so a typo would look like a working command
// that simply did nothing.
func TestRoomControlRejectsAnUnknownAction(t *testing.T) {
	h := newRoomTestHandler(t)
	for _, body := range []string{
		`{"room":"42","action":"explode"}`,
		`{"room":"42","action":""}`,
		`{"room":"42"}`,
	} {
		if w := roomPost(t, h, body); w.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400", body, w.Code)
		}
	}
}

func TestRoomControlRejectsBadJSON(t *testing.T) {
	w := roomPost(t, newRoomTestHandler(t), `{not json`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestRoomControlValidatesPerActionPayload(t *testing.T) {
	h := newRoomTestHandler(t)
	cases := map[string]string{
		"jump without a time":   `{"room":"42","action":"jump"}`,
		"jump with a bad time":  `{"room":"42","action":"jump","time":"not-a-time"}`,
		"focus without an app":  `{"room":"42","action":"focus"}`,
		"message without a msg": `{"room":"42","action":"message"}`,
	}
	for name, body := range cases {
		if w := roomPost(t, h, body); w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", name, w.Code)
		}
	}
}

// buildRoomCommand is the pure half of the handler, so the accepted payloads
// can be asserted without a database standing in the way.
func TestBuildRoomCommandAcceptsValidPayloads(t *testing.T) {
	jump, err := buildRoomCommand(roomRequest{Room: "42", Action: "jump", Time: "2001-09-11T13:03:00Z"})
	if err != nil {
		t.Fatalf("jump: %v", err)
	}
	if jump.Time.Format("2006-01-02T15:04:05Z") != "2001-09-11T13:03:00Z" {
		t.Fatalf("jump time = %v", jump.Time)
	}
	focus, err := buildRoomCommand(roomRequest{Room: "42", Action: "focus", App: "TV.app"})
	if err != nil || focus.App != "TV.app" {
		t.Fatalf("focus: %+v err=%v", focus, err)
	}
	msg, err := buildRoomCommand(roomRequest{Room: "42", Action: "message", Message: "Look at channel 4"})
	if err != nil || msg.Message != "Look at channel 4" {
		t.Fatalf("message: %+v err=%v", msg, err)
	}
	// Reload deliberately has no payload to validate: the definition is
	// re-fetched from Directus by each client, never relayed through here.
	reload, err := buildRoomCommand(roomRequest{Room: "42", Action: "reload"})
	if err != nil || reload.Action != "reload" {
		t.Fatalf("reload: %+v err=%v", reload, err)
	}
	if !model.ValidRoomAction("reload") {
		t.Fatal("reload must be a relayable action")
	}
}

// The authorisation rule lives in one SQL predicate, so assert its shape here:
// a regression that dropped the WHERE, or matched on something other than the
// creator, would make every playlist drivable by any signed-in user.
func TestPlaylistOwnerQueryMatchesCreatorOfTheRequestedPlaylist(t *testing.T) {
	q := strings.Join(strings.Fields(db.PlaylistOwnerSelectForTest), " ")
	want := "SELECT user_created FROM playlists WHERE id::text = $1"
	if q != want {
		t.Fatalf("owner query changed:\n got: %s\nwant: %s", q, want)
	}
}

// The authorisation rule itself. The handler cannot reach this with a nil pool,
// so the decision is tested directly — including the two blank cases, which are
// what an `owner == uid` check alone would get catastrophically wrong.
func TestMayDriveRoom(t *testing.T) {
	const teacher = "11111111-1111-1111-1111-111111111111"
	const someoneElse = "22222222-2222-2222-2222-222222222222"

	cases := []struct {
		name       string
		owner, uid string
		want       bool
	}{
		{"the creator drives their own playlist", teacher, teacher, true},
		{"another signed-in user may not", teacher, someoneElse, false},
		{"an unauthenticated caller may not", teacher, "", false},
		{"an unowned playlist is drivable by nobody", "", teacher, false},
		{"blank owner and blank caller must not match", "", "", false},
	}
	for _, c := range cases {
		if got := mayDriveRoom(c.owner, c.uid); got != c.want {
			t.Errorf("%s: mayDriveRoom(%q, %q) = %v, want %v", c.name, c.owner, c.uid, got, c.want)
		}
	}
}

func TestRoomControlValidatesLockTarget(t *testing.T) {
	h := newRoomTestHandler(t)
	for _, body := range []string{
		`{"room":"42","action":"lock"}`,
		`{"room":"42","action":"lock","target":""}`,
		// "content" is a real button in the teacher UI, but disabled and wired
		// to nothing — relaying it would make a dead control look live.
		`{"room":"42","action":"lock","target":"content","on":true}`,
	} {
		if w := roomPost(t, h, body); w.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status = %d, want 400", body, w.Code)
		}
	}
}

// The unlock command is `on:false`, which is also bool's zero value — so this
// pins that it survives decoding and reaches the published command.
func TestBuildRoomCommandCarriesLockState(t *testing.T) {
	on, err := buildRoomCommand(roomRequest{Room: "42", Action: "lock", Target: "clock", On: true})
	if err != nil || on.Target != "clock" || !on.On {
		t.Fatalf("lock on: %+v err=%v", on, err)
	}
	off, err := buildRoomCommand(roomRequest{Room: "42", Action: "lock", Target: "clock", On: false})
	if err != nil || off.Target != "clock" || off.On {
		t.Fatalf("lock off: %+v err=%v", off, err)
	}
}
