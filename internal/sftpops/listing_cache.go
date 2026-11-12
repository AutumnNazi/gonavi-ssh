package sftpops

import "time"

const (
	directoryCacheTTL    = 30 * time.Second
	maxCachedEntries     = 100000
	maxCachedDirectories = 16
)

type directoryKey struct{ connectionID, path, sortBy string }
type directorySnapshot struct {
	entries []Entry
	created time.Time
}

func directoryPage(entries []Entry, offset, limit int) ([]Entry, bool, error) {
	if offset >= len(entries) {
		return []Entry{}, false, nil
	}
	end := offset + min(limit, len(entries)-offset)
	return append([]Entry{}, entries[offset:end]...), end < len(entries), nil
}

func (m *Manager) cacheDirectory(key directoryKey, entries []Entry, epoch, readID uint64) {
	if len(entries) > maxCachedEntries {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.listingEpoch != epoch || m.listingReads[key] != readID {
		return
	}
	now := time.Now()
	delete(m.listings, key)
	total := len(entries)
	for k, snapshot := range m.listings {
		if now.Sub(snapshot.created) >= directoryCacheTTL {
			delete(m.listings, k)
		} else {
			total += len(snapshot.entries)
		}
	}
	for len(m.listings) >= maxCachedDirectories || total > maxCachedEntries {
		var oldest directoryKey
		var at time.Time
		for k, snapshot := range m.listings {
			if at.IsZero() || snapshot.created.Before(at) {
				oldest, at = k, snapshot.created
			}
		}
		total -= len(m.listings[oldest].entries)
		delete(m.listings, oldest)
	}
	m.listings[key] = directorySnapshot{entries: entries, created: now}
}

// Invalidate discards directory snapshots after a mutation, including transfers.
func (m *Manager) Invalidate(connectionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.invalidateListingsLocked(connectionID)
}

func (m *Manager) invalidateListingsLocked(connectionID string) {
	m.listingEpoch++
	for key := range m.listings {
		if key.connectionID == connectionID {
			delete(m.listings, key)
		}
	}
}
