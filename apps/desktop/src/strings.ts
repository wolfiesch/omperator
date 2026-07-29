/**
 * Native shell string catalog for T4 Code.
 *
 * Single source of truth for every human-visible string owned by the
 * Electron main process: application menus, native dialogs, window
 * titles, notifications, and accessibility labels.
 *
 * Rules:
 * - Strings only. No Electron imports, no functions, no runtime state.
 * - Menu labels follow platform conventions (`&` is not used; Electron
 *   derives accelerators from `accelerator`, never from label text).
 * - `menu.view.toggleDevTools` is shown in development builds only.
 */

export const APP_NAME = 'T4 Code' as const;

export const strings = {
  app: {
    name: APP_NAME,
  },

  menu: {
    app: {
      label: APP_NAME,
      about: `About ${APP_NAME}`,
      settings: 'Settings\u2026',
      updates: 'Updates\u2026',
      quit: `Quit ${APP_NAME}`,
    },
    file: {
      label: 'File',
      newWindow: 'New Window',
      connect: 'Connect\u2026',
      disconnect: 'Disconnect',
      close: 'Close Window',
    },
    view: {
      label: 'View',
      reload: 'Reload',
      toggleDevTools: 'Toggle Developer Tools',
    },
    window: {
      label: 'Window',
      minimize: 'Minimize',
    },
    help: {
      label: 'Help',
    },
  },

  dialog: {
    offline: {
      title: 'No Connection',
      message: `${APP_NAME} is offline.`,
      detail: 'Check your network connection, then try again.',
      retry: 'Retry',
      dismiss: 'Dismiss',
    },
    reconnect: {
      title: 'Connection Lost',
      message: 'The connection to the app server was interrupted.',
      detail: 'You can reconnect now or keep working offline.',
      reconnect: 'Reconnect',
      stayOffline: 'Stay Offline',
    },
    error: {
      title: 'Something Went Wrong',
      message: `${APP_NAME} hit an unexpected error.`,
      detail: 'You can reload the window or quit. Unsaved state may be lost.',
      reload: 'Reload',
      quit: 'Quit',
    },
    unsafeNavigation: {
      title: 'Open External Link?',
      message: 'This link leads outside the app.',
      detail: 'It will open in your default browser.',
      open: 'Open Link',
      cancel: 'Cancel',
    },
    appserverUnavailable: {
      title: 'App Server Unavailable',
      message: 'The app server is not responding.',
      detail: 'Make sure the server is running, then retry.',
      retry: 'Retry',
      quit: 'Quit',
    },
  },

  window: {
    title: APP_NAME,
    fixtureModeSuffix: 'Fixture Mode',
  },

  fixture: {
    badge: 'Fixture Mode',
    description: 'Running against recorded data. No live connection.',
  },

  notification: {
    reconnected: {
      title: 'Connection Restored',
      body: 'You are back online.',
    },
    updateReady: {
      title: 'Update Ready',
      body: `Restart ${APP_NAME} to finish updating.`,
    },
  },

  accessibility: {
    mainWindow: `${APP_NAME} main window`,
    fixtureBadge: 'Fixture mode indicator',
    connectionStatus: 'Connection status',
  },
} as const;

export type Strings = typeof strings;
