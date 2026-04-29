import { Outlet, Route, createBrowserRouter, createRoutesFromElements } from 'react-router-dom'

function AppLayout() {
  return <Outlet />
}

function HomePage() {
  return null
}

function SettingsPage() {
  return null
}

export const router = createBrowserRouter(
  createRoutesFromElements(
    <>
      <Route path="/" element={<AppLayout />}>
        <>
          <Route index element={<HomePage />} />
          <Route path="settings" Component={SettingsPage} />
        </>
      </Route>
    </>,
  ),
)
