// @ts-nocheck
import { configureStore } from '@reduxjs/toolkit'

import authReducer from './redux-cross-file-default-slice.js'

export const store = configureStore({
  reducer: {
    auth: authReducer,
  },
})
