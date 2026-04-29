import { createBrowserRouter } from 'react-router-dom'

import {
  RouteComponent as AdminPage,
  routeAction as adminAction,
  routeLoader as adminLoader,
} from './react-router-colliding-routes/admin/index'
import {
  RouteComponent as SettingsPage,
  routeAction as settingsAction,
  routeLoader as settingsLoader,
} from './react-router-colliding-routes/settings/index'

export const router = createBrowserRouter([
  {
    path: '/admin',
    Component: AdminPage,
    loader: adminLoader,
    action: adminAction,
  },
  {
    path: '/settings',
    Component: SettingsPage,
    loader: settingsLoader,
    action: settingsAction,
  },
])
