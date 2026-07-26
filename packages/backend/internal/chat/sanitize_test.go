package chat

import (
	"strings"
	"testing"
)

func TestSanitizeStripsEverythingButPlainText(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"markdown bold", "that is **really** bad", "that is really bad"},
		{"markdown italic", "that is _really_ bad", "that is really bad"},
		{"backticks", "type `brb` ok", "type brb ok"},
		{"unicode emoji", "omg 😱 scary", "omg scary"},
		{"smart quotes", "he said “hi”", `he said "hi"`},
		{"em dash", "wait — what", "wait - what"},
		{"url", "see http://cnn.com now", "see now"},
		{"collapse whitespace", "omg    what\n\n\nis   that", "omg what is that"},
		{"keeps emoticon", "im scared :-(", "im scared :-("},
		{"keeps apostrophe", "i dont know", "i dont know"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Sanitize(c.in, 500); got != c.want {
				t.Errorf("Sanitize(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestSanitizeCapsLengthOnAWordBoundary(t *testing.T) {
	got := Sanitize("aaaa bbbb cccc dddd", 10)
	if len([]rune(got)) > 10 {
		t.Errorf("exceeded cap: %q", got)
	}
	if strings.HasSuffix(got, " ") {
		t.Errorf("trailing space after truncation: %q", got)
	}
}

func TestSanitizeIsIdempotent(t *testing.T) {
	in := "**omg** 😱 see http://x.com — now"
	once := Sanitize(in, 500)
	if twice := Sanitize(once, 500); once != twice {
		t.Errorf("not idempotent: %q then %q", once, twice)
	}
}

func TestSanitizeStripsControlCharacters(t *testing.T) {
	// ESC, NUL, and BEL should not survive sanitization
	in := "hi\x1b[31mred\x1b[0m\x00end\x07bell"
	got := Sanitize(in, 500)
	if strings.Contains(got, "\x1b") || strings.Contains(got, "\x00") || strings.Contains(got, "\x07") {
		t.Errorf("control characters not stripped: %q", got)
	}
	// Should preserve the words without the escape sequences
	if !strings.Contains(got, "hi") || !strings.Contains(got, "red") || !strings.Contains(got, "end") || !strings.Contains(got, "bell") {
		t.Errorf("stripped too much: %q", got)
	}
}

func TestSanitizeIdempotentWithSplitSchemeURL(t *testing.T) {
	// Regression: markdown character inside URL scheme should not leak a URL
	in := "see h*ttp://cnn.com now"
	once := Sanitize(in, 500)
	twice := Sanitize(once, 500)
	if once != twice {
		t.Errorf("not idempotent with split-scheme URL: first %q, second %q", once, twice)
	}
	// URL should be stripped (markdown removed first, then URL regex can match)
	if strings.Contains(once, "cnn.com") || strings.Contains(once, "://") {
		t.Errorf("URL not stripped from result: %q", once)
	}
}

func TestHasAnachronismCatchesPostEraSlang(t *testing.T) {
	for _, bad := range []string{"smh", "fr fr", "ngl that was wild", "bruh"} {
		if _, found := HasAnachronism(bad); !found {
			t.Errorf("missed anachronism in %q", bad)
		}
	}
	// Must match whole words only: "brb" is era-correct and contains no anachronism,
	// and "ngl" must not fire inside "angle".
	for _, ok := range []string{"brb", "g2g", "what is the angle on that", "sup"} {
		if term, found := HasAnachronism(ok); found {
			t.Errorf("false positive %q in %q", term, ok)
		}
	}
}
