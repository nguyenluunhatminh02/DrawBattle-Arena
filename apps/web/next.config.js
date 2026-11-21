// Build-time configuration for the web app.
//
// NEXT_PUBLIC_API_URL is optional. When unset (the default), the browser uses
// same-origin URLs and Next.js rewrites proxy /api/*, /game/* and static assets
// to the API. This prevents production builds from silently embedding
// http://localhost:3001 in the browser bundle.
const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL?.trim() || '';

if (PUBLIC_API_URL && !/^https?:\/\//.test(PUBLIC_API_URL)) {
  throw new Error(
    'NEXT_PUBLIC_API_URL must be an absolute http(s) URL (e.g. https://api.example.com), or leave it empty for same-origin API access.',
  );
}

// INTERNAL_API_URL is the server-side proxy target. It defaults to the
// Compose service name so `docker compose up` works without extra config, and
// can be overridden for local dev / CI (where the API runs on localhost:3001).
const INTERNAL_API_URL = (process.env.INTERNAL_API_URL || 'http://api:3001').replace(/\/$/, '');

module.exports = {
  reactStrictMode: true,
  transpilePackages: ['@drawbattle/shared'],
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${INTERNAL_API_URL}/api/:path*`,
      },
      {
        source: '/game/:path*',
        destination: `${INTERNAL_API_URL}/game/:path*`,
      },
      {
        // socket.io-client uses /socket.io by default even when the namespace
        // is /game; same-origin builds must proxy that handshake too.
        source: '/socket.io/:path*',
        destination: `${INTERNAL_API_URL}/socket.io/:path*`,
      },
      {
        source: '/avatars/:path*',
        destination: `${INTERNAL_API_URL}/avatars/:path*`,
      },
      {
        source: '/replays/:path*',
        destination: `${INTERNAL_API_URL}/replays/:path*`,
      },
    ];
  },
};
