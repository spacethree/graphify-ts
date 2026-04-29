import express from 'express'

import { routerA } from './express-cross-file-cycle-router-a'

export const routerB = express.Router()

function showLeaf() {}

routerB.get('/leaf', showLeaf)
routerB.use('/a', routerA)
