import express from 'express'

function showUser() {}

export const usersRouter = express.Router()

usersRouter.get('/users/:id', showUser)
