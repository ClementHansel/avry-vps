# Aivory VPS Orchestration

Aivory VPS Orchestration — Nginx reverse proxy configuration, deployment scripts, Docker networking, and end-to-end testing for the production VPS.

## Tech Stack

- Node.js
- TypeScript
- Playwright
- Docker
- Nginx

## Getting Started

### Prerequisites

- Node.js 18+
- Docker & Docker Compose
- Nginx (for local proxy testing)

### Local Development

```bash
npm install
npm run dev
```

### Running Tests

```bash
npx playwright test
```

### Environment Variables

Copy `.env.example` to `.env` and fill in the required values.

```bash
cp .env.example .env
```

## Docker

```bash
docker-compose up -d
```

This brings up the full proxy and networking stack locally.

## VPS Deployment

1. SSH into the VPS
2. Clone or pull this repo
3. Configure `.env` with production values
4. Deploy the full stack:

```bash
docker-compose up -d --build
```

5. Nginx configuration is in `nginx/` — reload after changes:

```bash
sudo nginx -t && sudo systemctl reload nginx
```
