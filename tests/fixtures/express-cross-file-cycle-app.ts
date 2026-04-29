import express from 'express'

import { routerA } from './express-cross-file-cycle-router-a'

const app = express()

app.use('/api', routerA)

export default app
