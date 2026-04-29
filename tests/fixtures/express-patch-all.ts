const express = require('express')

function requireAuth(_req: unknown, _res: unknown, next: () => void) {
  next()
}

function patchUser() {}
function handleAudit() {}

const app = express()

app.patch('/users/:id/profile', requireAuth, patchUser)
app.all('/users/:id/audit', requireAuth, handleAudit)

export default app
