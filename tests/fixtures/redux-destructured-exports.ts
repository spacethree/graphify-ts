// @ts-nocheck
import { createSlice } from '@reduxjs/toolkit'

export const authSlice = createSlice({
  name: 'auth',
  initialState: { token: null as string | null, status: 'idle' as 'idle' | 'ready' },
  reducers: {
    logout(state) {
      state.token = null
    },
    loginSucceeded(state, action: { payload: string }) {
      state.token = action.payload
    },
  },
  selectors: {
    selectToken: (state) => state.token,
    selectStatus: (state) => state.status,
  },
})

export const { logout, loginSucceeded: signInSucceeded } = authSlice.actions
export const { selectToken, selectStatus: selectAuthStatus } = authSlice.selectors
