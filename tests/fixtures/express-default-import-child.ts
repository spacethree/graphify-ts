import express from 'express'

function listUser() {}

const apiRouter = express.Router()

apiRouter.get('/users/:id', listUser)

export default apiRouter
