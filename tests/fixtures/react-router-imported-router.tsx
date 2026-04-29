import { createBrowserRouter } from 'react-router-dom'

import { SettingsPage, settingsAction, settingsLoader } from './react-router-imported-module'

export const router = createBrowserRouter([
  {
    path: '/settings',
    Component: SettingsPage,
    loader: settingsLoader,
    action: settingsAction,
  },
])
