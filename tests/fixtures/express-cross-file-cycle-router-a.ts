import express from 'express'

import { routerB } from './express-cross-file-cycle-router-b'

export const routerA = express.Router()

function showLocal() {}

routerA.get('/local', showLocal)
routerA.use('/b', routerB)
