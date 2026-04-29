import express from 'express'

function listUser() {}

export const apiRouter = express.Router()

apiRouter.get('/users/:id', listUser)
