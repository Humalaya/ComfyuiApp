import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { useEffect, useRef } from 'react'

// Android back button, layered: whatever was opened most recently and is
// still open (a viewer, the drawer, a help card, a Galeri subfolder…)
// handles a press first; only when nothing is open does the root handler
// (App.tsx: go back to the home screen, or exit) run. Registering any
// backButton listener also turns off Capacitor's default behavior (WebView
// history back / closing the app on the first press).

type Handler = () => void

const stack: { run: Handler }[] = []
let root: Handler | null = null
let installed = false

function install() {
  if (installed || !Capacitor.isNativePlatform()) return
  installed = true
  App.addListener('backButton', () => {
    const top = stack[stack.length - 1]
    if (top) top.run()
    else root?.()
  })
}

// While `enabled`, a back press calls `onBack` instead of anything opened
// before it. `onBack` may change every render; the latest one is used.
export function useBackHandler(enabled: boolean, onBack: Handler) {
  const latest = useRef(onBack)
  useEffect(() => {
    latest.current = onBack
  })
  useEffect(() => {
    if (!enabled) return
    install()
    const entry = { run: () => latest.current() }
    stack.push(entry)
    return () => {
      const i = stack.indexOf(entry)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [enabled])
}

// The fallback when nothing registered with useBackHandler is open.
export function useRootBackHandler(onBack: Handler) {
  const latest = useRef(onBack)
  useEffect(() => {
    latest.current = onBack
  })
  useEffect(() => {
    install()
    const handler = () => latest.current()
    root = handler
    return () => {
      if (root === handler) root = null
    }
  }, [])
}

export function exitApp() {
  if (Capacitor.isNativePlatform()) App.exitApp()
}
