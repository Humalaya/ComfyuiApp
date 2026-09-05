import { useCallback, useEffect, useState } from 'react'
import { listOutputs, listSources, type OutputFile, type OutputSource } from '../api/outputsClient'

// Lists one directory level of a configured output folder on disk (via the
// local backend) — folders to browse into, plus files sorted newest-first.
// This replaced the earlier /history-based gallery: reading the filesystem
// directly is simpler and doesn't miss outputs that scrolled out of
// ComfyUI's in-memory history.
export function useOutputBrowser(source: string, path: string) {
  const [folders, setFolders] = useState<string[]>([])
  const [items, setItems] = useState<OutputFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const listing = await listOutputs(source, path)
      setFolders(listing.folders)
      setItems(listing.files)
    } catch (err) {
      setFolders([])
      setItems([])
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [source, path])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { folders, items, loading, error, refresh }
}

// Which output folders the backend is actually configured to serve — drives
// the source-switcher tabs so an unconfigured source (missing env var) never
// shows up as a dead tab.
export function useOutputSources() {
  const [sources, setSources] = useState<OutputSource[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    listSources()
      .then((s) => {
        if (!cancelled) setSources(s.filter((source) => source.configured))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { sources, loading }
}
