import express from 'express'
import { usersRouter } from './express-nested-router-grandchild'

function auditTrail(_req: unknown, _res: unknown, next: () => void) {
  next()
}

export const apiRouter = express.Router()

apiRouter.use('/v1', auditTrail, usersRouter)
