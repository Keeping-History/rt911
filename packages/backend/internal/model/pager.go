package model

import "time"

// PagerItem represents a single historical pager message. Unlike MediaItem,
// every pager item is "instant" — it has a start_date but no duration or
// end_date — so the cache and delivery paths treat it as a point in time.
type PagerItem struct {
	ID          int       `json:"id"`
	StartDate   time.Time `json:"start_date"`
	Provider    string    `json:"provider,omitempty"`
	RecipientID string    `json:"recipient_id,omitempty"`
	IDType      string    `json:"id_type,omitempty"`
	Channel     string    `json:"channel,omitempty"`
	Mode        string    `json:"mode,omitempty"`
	Message     string    `json:"message"`
	Approved    int       `json:"approved"`
}
