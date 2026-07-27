package model

// Buddy is one entry in the chat channel's roster frame. It is the wire
// projection of chat.Profile — the config record carries authoring fields the
// client has no use for.
type Buddy struct {
	ID          int    `json:"id"`
	ScreenName  string `json:"screen_name"`
	DisplayName string `json:"display_name,omitempty"`
	Avatar      string `json:"avatar,omitempty"`
	Online      bool   `json:"online"`
	ProfileText string `json:"profile_text,omitempty"`
}
