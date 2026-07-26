package chat

import (
	"regexp"
	"strings"
)

var (
	reURL       = regexp.MustCompile(`https?://\S+|www\.\S+`)
	reMarkdown  = regexp.MustCompile("[*_`~#>]+")
	reWhitespace = regexp.MustCompile(`\s+`)
	reWordChars = regexp.MustCompile(`[a-z0-9]+`)
)

// replacements maps era-incorrect typography to its ASCII equivalent. A 2001 AIM
// client could not render any of these, so they are as wrong as an emoji.
var replacements = strings.NewReplacer(
	"“", `"`, "”", `"`,
	"‘", "'", "’", "'",
	"—", "-", "–", "-",
	"…", "...",
)

// Anachronisms are terms that postdate 2001 and instantly break the illusion.
var Anachronisms = []string{
	"smh", "fr", "ngl", "bruh", "lowkey", "highkey", "sus", "yeet",
	"cringe", "based", "vibe", "vibes", "salty", "ghosted", "selfie",
	"google", "googled", "texting", "texted", "wifi", "app", "apps",
	"smartphone", "iphone", "youtube", "facebook", "twitter", "tweet",
}

// Sanitize reduces a generated reply to what a 2001 IM client could display:
// plain ASCII text and text emoticons. Everything else is removed rather than
// escaped -- a buddy typing a literal asterisk is a bug, not a style choice.
func Sanitize(s string, maxRunes int) string {
	s = replacements.Replace(s)
	s = reURL.ReplaceAllString(s, "")
	s = reMarkdown.ReplaceAllString(s, "")

	// Drop anything still non-ASCII: emoji, accented characters, box drawing.
	var b strings.Builder
	for _, r := range s {
		if r < 128 {
			b.WriteRune(r)
		}
	}
	s = reWhitespace.ReplaceAllString(b.String(), " ")
	s = strings.TrimSpace(s)

	return truncateRunes(s, maxRunes)
}

// truncateRunes cuts at the last space before the cap so a reply never ends
// mid-word, which reads as a crash rather than as brevity.
func truncateRunes(s string, maxRunes int) string {
	r := []rune(s)
	if maxRunes <= 0 || len(r) <= maxRunes {
		return s
	}
	cut := string(r[:maxRunes])
	if i := strings.LastIndex(cut, " "); i > 0 {
		cut = cut[:i]
	}
	return strings.TrimSpace(cut)
}

// HasAnachronism reports the first post-2001 term found, matching whole words
// only so "ngl" does not fire inside "angle".
func HasAnachronism(s string) (string, bool) {
	words := reWordChars.FindAllString(strings.ToLower(s), -1)
	seen := make(map[string]bool, len(words))
	for _, w := range words {
		seen[w] = true
	}
	for _, a := range Anachronisms {
		if seen[a] {
			return a, true
		}
	}
	return "", false
}
