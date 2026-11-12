package plugin

// Exporter declares one host-managed bounded snapshot format, not filesystem authority.
// It requires data.export, a backend and an exact declared command; all fields are required.
type Exporter struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Command     string `json:"command"`
	Extension   string `json:"extension"`
	ContentType string `json:"contentType"`
	Streaming   bool   `json:"streaming,omitempty"`
}
