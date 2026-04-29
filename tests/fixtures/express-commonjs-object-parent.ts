const express = require('express')
const child = require('./express-commonjs-object-child')

const app = express()

app.use('/api', child.router)

module.exports = app
