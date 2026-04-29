import express from 'express'
import apiRouter from './express-default-import-child'

const app = express()

app.use('/api', apiRouter)
