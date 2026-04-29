// @ts-nocheck
import { createSlice } from '@reduxjs/toolkit'

export type AuthState = {
  token: string | null
  status: 'idle' | 'ready'
}

export const initialState: AuthState = {
  token: null,
  status: 'idle',
}

export const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    loginSucceeded(state, action: { payload: string }) {
      state.token = action.payload
      state.status = 'ready'
    },
    logout(state) {
      state.token = null
      state.status = 'idle'
    },
  },
  selectors: {
    selectToken: (state) => state.token,
    selectStatus: (state) => state.status,
  },
})

export const { selectStatus: selectAuthStatus } = authSlice.selectors
export const authReducer = authSlice.reducer
