package handler

import "testing"

func TestClampChatHistoryLimit(t *testing.T) {
	// A client-supplied limit must be bounded in both directions: too small
	// (or omitted/negative) falls back to the default, and too large must not
	// walk the whole conversation into one query -- {"limit": 1000000} is
	// exactly the request this guards against.
	cases := []struct {
		name  string
		limit int
		want  int
	}{
		{"omitted", 0, chatHistoryDefaultLimit},
		{"negative", -1, chatHistoryDefaultLimit},
		{"within bound", 10, 10},
		{"at bound", chatHistoryDefaultLimit, chatHistoryDefaultLimit},
		{"over bound", chatHistoryDefaultLimit + 1, chatHistoryDefaultLimit},
		{"absurdly over bound", 1000000, chatHistoryDefaultLimit},
	}
	for _, c := range cases {
		if got := clampChatHistoryLimit(c.limit); got != c.want {
			t.Errorf("%s: clampChatHistoryLimit(%d) = %d, want %d", c.name, c.limit, got, c.want)
		}
	}
}
