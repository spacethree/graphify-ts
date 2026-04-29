// @ts-nocheck
import { configureStore } from '@reduxjs/toolkit'

import { authReducer } from './redux-cross-file-slice.js'

export const store = configureStore({
  reducer: {
    auth: authReducer,
  },
})
