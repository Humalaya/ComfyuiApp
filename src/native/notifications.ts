import { LocalNotifications } from '@capacitor/local-notifications'
import { isNativeApp } from './keepAlive'

// Fixed id on purpose: a new generation's result notification replaces the
// previous one instead of piling up in the notification shade — only the
// latest result matters.
const RESULT_NOTIFICATION_ID = 1000

export async function notify(title: string, body: string): Promise<void> {
  if (!isNativeApp()) return
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: RESULT_NOTIFICATION_ID,
          title,
          body,
          smallIcon: 'ic_stat_keepalive',
          autoCancel: true,
        },
      ],
    })
  } catch {
    // Best-effort — a denied permission or plugin error shouldn't affect the
    // generation flow itself, it just means no notification is shown.
  }
}
