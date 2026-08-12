import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
// LAN_DEMO=1 opts into binding beyond localhost, for a phone on the same
// Wi-Fi to load the dev server and scan a real QR code. Unset by default --
// `npm run dev` behaves exactly as before unless explicitly requested.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: process.env.LAN_DEMO === "1" ? true : "localhost",
  },
})
