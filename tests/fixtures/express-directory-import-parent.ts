import express from 'express'

import routes from './express-directory-routes'

const app = express()

app.use('/api', routes)

export default app
