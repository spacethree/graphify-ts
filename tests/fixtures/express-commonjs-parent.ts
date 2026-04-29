const express = require('express')
const apiRouter = require('./express-commonjs-child')

const app = express()

app.use('/api', apiRouter)
