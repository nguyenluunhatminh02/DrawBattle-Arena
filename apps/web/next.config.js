const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

module.exports = {
  reactStrictMode: true,
  transpilePackages: ['@drawbattle/shared'],
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${API_URL}/api/:path*`,
      },
      {
        source: '/avatars/:path*',
        destination: `${API_URL}/avatars/:path*`,
      },
      {
        source: '/replays/:path*',
        destination: `${API_URL}/replays/:path*`,
      },
    ];
  },
};
