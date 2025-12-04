# WhatsApp Backend for TillPoint

This is a robust WhatsApp Web API server designed to run on Render.

## Features
- **Robust Message Sending**: Handles new chats automatically without crashing.
- **Webhooks**: Sends QR codes and status updates to Supabase.
- **Authentication**: Protected by `x-api-key`.

## Deployment to Render

1. **Create a new GitHub Repository** (e.g., `tillpoint-whatsapp-backend`).
2. **Push this code** to the repository:
   ```bash
   cd whatsapp-backend
   git init
   git add .
   git commit -m "Initial commit"
   # Replace with your repo URL
   git remote add origin https://github.com/YOUR_USERNAME/tillpoint-whatsapp-backend.git
   git push -u origin main
   ```
3. **Go to Render Dashboard**:
   - Select your existing `tillpoint-whatsapp` service.
   - Go to **Settings**.
   - Scroll down to **Source** (or Repository).
   - Click **Edit** and connect your new repository (`tillpoint-whatsapp-backend`).
   - Render will automatically redeploy with this new, fixed code.

## Environment Variables (Already set on Render)
- `API_KEY`: Your secret key (must match Supabase).
- `BASE_WEBHOOK_URL`: Your Supabase webhook URL.
