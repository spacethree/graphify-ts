import express from 'express'

function requireAuth(_req: unknown, _res: unknown, next: () => void) {
  next()
}

class UsersController {
  showUser() {}
}

const controller = new UsersController()
const app = express()

app.get('/users/:id', requireAuth, controller.showUser)
