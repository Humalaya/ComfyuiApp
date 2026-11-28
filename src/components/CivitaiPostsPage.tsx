import { useCallback, useEffect, useRef, useState } from 'react'
import {
  civitaiThumbUrl,
  fetchCivitaiPage,
  type CivitaiItem,
  type CivitaiPeriod,
  type CivitaiSort,
  type CivitaiTag,
} from '../api/civitaiBrowser'
import { formatCount, PERIODS } from './civitaiShared'
import { useBackHandler } from '../native/backButton'
import { CivitaiViewer } from './CivitaiBrowser'
import type { ModelRef } from './CivitaiModelPage'
import type { ImportPayload } from './Gallery'

// Whose posts: a user (their name tapped in the viewer, or a
// civitai.com/user/… link) or one post (a civitai.com/posts/… link).
export type PostsSource = { username: string } | { postId: number }

interface Props {
  source: PostsSource
  onClose: () => void
  onOpenUser: (username: string) => void
  onOpenModel: (ref: ModelRef) => void
  onSendToCreate: (payload: ImportPayload) => void
  onPickTag?: (tag: CivitaiTag, type: 'image' | 'video') => void
}

type MediaType = 'all' | 'image' | 'video'

// A Civitai user's (or one post's) pictures and videos — just the posts,
// nothing else of the profile. Same tiles and viewer as the main feed.
export function CivitaiPostsPage({ source, onClose, onOpenUser, onOpenModel, onSendToCreate, onPickTag }: Props) {
  useBackHandler(true, onClose)
  const isUser = 'username' in source
  const [type, setType] = useState<MediaType>('all')
  const [sort, setSort] = useState<CivitaiSort>('Newest')
  const [period, setPeriod] = useState<CivitaiPeriod>('AllTime')
  const [items, setItems] = useState<CivitaiItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const requestId = useRef(0)
  const key = isUser ? `u:${source.username}` : `p:${source.postId}`

  const load = useCallback(
    async (from: string | null) => {
      const id = ++requestId.current
      setLoading(true)
      setError(null)
      try {
        const page = await fetchCivitaiPage(
          {
            type,
            sort,
            period: sort === 'Newest' ? 'AllTime' : period,
            baseModels: [],
            withMeta: false,
            nsfwOnly: false,
            modelVersion: null,
            ...(isUser ? { username: source.username } : { postId: source.postId }),
          },
          from,
        )
        if (id !== requestId.current) return
        setItems((prev) => (from ? [...prev, ...page.items] : page.items))
        setCursor(page.nextCursor)
      } catch (e) {
        if (id === requestId.current) setError((e as Error).message)
      } finally {
        if (id === requestId.current) setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [type, sort, period, key],
  )

  useEffect(() => {
    setItems([])
    setCursor(null)
    setViewerIndex(null)
    load(null)
  }, [load])

  const seg = (a: boolean) => (a ? 'seg-btn seg-btn-active' : 'seg-btn')
  const title = isUser ? source.username : 'Post'
  const pageUrl = isUser ? `https://civitai.com/user/${encodeURIComponent(source.username)}` : `https://civitai.com/posts/${source.postId}`

  return (
    <div className="civitai-model-page civitai-posts-page">
      <div className="civitai-model-head">
        <button type="button" className="icon-button" onClick={onClose} aria-label="Geri">
          ‹
        </button>
        <span className="civitai-model-title">{isUser ? `👤 ${title}` : title}</span>
        <a className="icon-button" href={pageUrl} target="_blank" rel="noreferrer" aria-label="Civitai'de aç">
          ↗
        </a>
      </div>

      {isUser && (
        <div className="civitai-toolbar">
          <div className="seg">
            <button type="button" className={seg(type === 'all')} onClick={() => setType('all')}>
              Hepsi
            </button>
            <button type="button" className={seg(type === 'image')} onClick={() => setType('image')}>
              Görseller
            </button>
            <button type="button" className={seg(type === 'video')} onClick={() => setType('video')}>
              Videolar
            </button>
          </div>
          <div className="seg">
            <button type="button" className={seg(sort === 'Newest')} onClick={() => setSort('Newest')}>
              Yeni
            </button>
            <button type="button" className={seg(sort === 'Most Reactions')} onClick={() => setSort('Most Reactions')}>
              Popüler
            </button>
          </div>
        </div>
      )}
      {isUser && sort === 'Most Reactions' && (
        <div className="chip-row">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              className={period === p.value ? 'chip chip-active' : 'chip'}
              onClick={() => setPeriod(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="status-warning">
          {error}
          <button type="button" className="secondary-button" onClick={() => load(items.length > 0 ? cursor : null)}>
            Tekrar dene
          </button>
        </div>
      )}
      <div className="civitai-grid">
        {items.map((item, i) => (
          <button key={item.id} type="button" className="civitai-tile" onClick={() => setViewerIndex(i)}>
            <img src={civitaiThumbUrl(item)} alt="" loading="lazy" />
            {item.type === 'video' && <span className="civitai-tile-play">▶</span>}
            <span className="civitai-tile-stats">♥ {formatCount(item.reactions)}</span>
          </button>
        ))}
      </div>
      {!loading && !error && items.length === 0 && <div className="empty-state">Paylaşım yok.</div>}
      {loading && <div className="spinner" aria-label="Yükleniyor" />}
      {!loading && cursor && (
        <button type="button" className="secondary-button more-button" onClick={() => load(cursor)}>
          Daha fazla
        </button>
      )}

      {viewerIndex !== null && items[viewerIndex] && (
        <CivitaiViewer
          items={items}
          index={viewerIndex}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          onSend={(payload) => {
            setViewerIndex(null)
            onSendToCreate(payload)
          }}
          onPickModel={(mv, t) => {
            setViewerIndex(null)
            onOpenModel({ versionId: mv.id, type: t })
          }}
          onPickTag={onPickTag}
          // Already this user's page: their name just closes the viewer.
          onPickUser={(name) => (isUser && name === source.username ? setViewerIndex(null) : onOpenUser(name))}
        />
      )}
    </div>
  )
}
