package handler

import (
	_ "embed"
	"log/slog"
	"net/http"
)

//go:embed chatdev.html
var chatDevPage []byte

// NewChatDevHandler serves the IM Buddies dev harness. It exists because the
// Directus session cookie is httpOnly: a browser is the only client that can
// exercise the real auth path, so a CLI harness would test a different one.
// Registered only when CHAT_DEV_UI=1.
func NewChatDevHandler(logger *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		if _, err := w.Write(chatDevPage); err != nil {
			logger.Warn("chat dev page write failed", "error", err)
		}
	}
}
