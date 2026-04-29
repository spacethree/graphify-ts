import express from 'express'

function showUser() {}

export const apiRouter = express.Router()

apiRouter.get('/users/:id', showUser)
