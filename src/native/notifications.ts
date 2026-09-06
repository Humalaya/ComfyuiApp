import { LocalNotifications } from '@capacitor/local-notifications'
import { isNativeApp } from './keepAlive'

// Fixed id on purpose: a new generation's result notification replaces the
// previous one instead of piling up in the notification shade — only the
// latest result matters.
const RESULT_NOTIFICATION_ID = 1000

// Same channel id KeepAliveService.java creates (with a custom sound,
// res/raw/notification_sound.mp3) — Android notification channels are keyed
// by id per-package, so reusing this one here means this JS-triggered path
// gets the same custom sound without having to define it twice. Whichever
// path (native service or this one) happens to run first creates it; the
// other's createChannel call below is then just a no-op.
const CHANNEL_ID = 'generation_result_v2'

let channelReady: Promise<void> | null = null

function ensureChannel(): Promise<void> {
  if (!channelReady) {
    channelReady = LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: 'Üretim Sonucu',
      description: 'Video üretimi tamamlandığında veya hata verdiğinde gösterilen bildirim',
      importance: 5,
      sound: 'notification_sound.mp3',
    }).catch(() => {
      // Best-effort — if this fails, schedule() below still works, just
      // possibly on whatever default channel/sound Android falls back to.
    })
  }
  return channelReady
}

export async function notify(title: string, body: string): Promise<void> {
  if (!isNativeApp()) return
  try {
    await ensureChannel()
    await LocalNotifications.schedule({
      notifications: [
        {
          id: RESULT_NOTIFICATION_ID,
          title,
          body,
          smallIcon: 'ic_stat_keepalive',
          channelId: CHANNEL_ID,
          autoCancel: true,
        },
      ],
    })
  } catch {
    // Best-effort — a denied permission or plugin error shouldn't affect the
    // generation flow itself, it just means no notification is shown.
  }
}
