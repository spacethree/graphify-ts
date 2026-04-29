// @ts-nocheck
import { configureStore } from '@reduxjs/toolkit'

import { authReducer } from './redux-retrieve-auth-slice.js'

export const store = configureStore({
  reducer: {
    auth: authReducer,
  },
})
