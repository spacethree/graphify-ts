import express from 'express'

import { routerA } from './express-cross-file-cycle-router-a.js'

const app = express()

app.use('/api', routerA)

export default app
