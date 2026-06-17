package model

import "time"

// UsenetItem represents a single archived Usenet (newsgroup) message. Like
// PagerItem it is "instant" — a start_date (the posting time) with no duration —
// so the cache and delivery paths treat it as a point in time. Newsgroup is the
// per-session filter dimension (a client only receives messages from the group(s)
// it is currently viewing); it is resolved from the linked sources row
// (type="usenet") at query time, not stored inline on the message.
//
// references/in_reply_to are kept raw; thread_id/parent_id are populated by the
// ingestion threading stage (see plans/usenet-archive-ingestion.md) and may be
// empty for messages that have not been threaded.
type UsenetItem struct {
	ID         int       `json:"id"`
	StartDate  time.Time `json:"start_date"`
	Newsgroup  string    `json:"newsgroup,omitempty"`
	Subject    string    `json:"subject,omitempty"`
	Author     string    `json:"author,omitempty"`
	MessageID  string    `json:"message_id,omitempty"`
	References string    `json:"references,omitempty"`
	InReplyTo  string    `json:"in_reply_to,omitempty"`
	ThreadID   string    `json:"thread_id,omitempty"`
	ParentID   string    `json:"parent_id,omitempty"`
	Body       string    `json:"body,omitempty"`
	DateSource string    `json:"date_source,omitempty"`
	Approved   int       `json:"approved"`
}
