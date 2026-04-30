import { saveTeamSettings } from './actions'
import { ClientTeamPanel } from './ClientTeamPanel'

export default function TeamPage() {
  return (
    <form action={saveTeamSettings}>
      <ClientTeamPanel />
    </form>
  )
}
