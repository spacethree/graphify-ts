import express from 'express'

import routes from './express-directory-routes/index.js'

const app = express()

app.use('/api', routes)

export default app
