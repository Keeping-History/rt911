package model

import "time"

// MediaItem represents a scheduled broadcast media entry.
type MediaItem struct {
	ID           int        `json:"id"`
	Title        string     `json:"title"`
	FullTitle    string     `json:"full_title"`
	Source       *string    `json:"source,omitempty"`
	StartDate    time.Time  `json:"start_date"`
	EndDate      *time.Time `json:"end_date,omitempty"`
	CalcDuration *int       `json:"calc_duration,omitempty"`
	Timezone     string     `json:"timezone,omitempty"`
	URL          string     `json:"url"`
	Format       string     `json:"format"`
	Approved     int        `json:"approved"`
	Mute         int        `json:"mute"`
	Volume       float64    `json:"volume"`
	Jump         int        `json:"jump"`
	Trim         int        `json:"trim"`
	Image        string     `json:"image,omitempty"`
	ImageCaption string     `json:"image_caption,omitempty"`
	Subtitles    string     `json:"subtitles,omitempty"`
	Content      string     `json:"content,omitempty"`
	Sort         *int       `json:"sort,omitempty"`
}

// AlertItem is a background alert. It reuses the full MediaItem shape (headline in
// Title, HTML body in Content, plus Image/ImageCaption/StartDate) and adds Severity,
// which selects the ClassicyAlert icon (note | caution | stop). Embedding keeps
// MediaItem — and every other channel's SELECT — untouched by the alert-only column.
type AlertItem struct {
	MediaItem
	Severity *string `json:"severity,omitempty"`
}
